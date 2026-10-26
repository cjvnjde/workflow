import { z } from "zod";
import { runProcess } from "./process.js";
import { githubEventSchema, type GithubEvent, type TriggerConfig } from "./trigger-schema.js";

export interface GithubTriggerSource {
  poll(config: TriggerConfig, since: string, signal: AbortSignal): Promise<GithubEvent[]>;
  item(config: TriggerConfig, number: number, signal: AbortSignal): Promise<GithubEvent>;
  findComment(event: GithubEvent, marker: string, signal: AbortSignal): Promise<string | undefined>;
  comment(event: GithubEvent, body: string, signal: AbortSignal): Promise<string>;
}
export class GithubRequestError extends Error {
  constructor(readonly status: number) { super(`GitHub request failed (${status}). Check repository access, authentication, and rate limits.`); }
}
const issueSchema = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullish(),
  user: z.object({ login: z.string() }).nullable(), labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  created_at: z.string().datetime(), updated_at: z.string().datetime(), pull_request: z.unknown().optional(),
});

/** Outbound-only GitHub.com adapter. Credentials never enter settings, events or workflow inputs. */
export class GithubPollingSource implements GithubTriggerSource {
  constructor(private readonly project: string, private readonly fetcher: typeof fetch = fetch, private readonly live = true) {}
  private async token(signal: AbortSignal) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) return token;
    try {
      const result = await runProcess(this.project, ["gh", "auth", "token", "--hostname", "github.com"], signal, 5000);
      if (result.exitCode === 0) return result.stdout.trim();
    } catch { signal.throwIfAborted(); }
    return undefined;
  }
  private async request(route: string, signal: AbortSignal, body?: unknown): Promise<{ data: unknown; more: boolean }> {
    if (!this.live) throw new Error("GitHub triggers require live mode; demo mode does not contact GitHub");
    const token = await this.token(signal);
    if (body !== undefined && !token) throw new GithubRequestError(401);
    const response = await this.fetcher(`https://api.github.com${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "predictable-workflow",
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new GithubRequestError(response.status); }
    return { data: await response.json(), more: /rel="next"/.test(response.headers.get("link") ?? "") };
  }
  private async event(config: TriggerConfig, raw: unknown, signal: AbortSignal) {
    const issue = issueSchema.parse(raw);
    const pr = issue.pull_request !== undefined;
    const kind = pr ? "pull_request.opened" : "issue.opened";
    if (config.event !== kind) return undefined;
    let pull: { head: { sha: string; ref: string }; base: { sha: string; ref: string }; draft?: boolean } | undefined;
    if (pr) pull = z.object({ head: z.object({ sha: z.string(), ref: z.string() }), base: z.object({ sha: z.string(), ref: z.string() }), draft: z.boolean().optional() })
      .parse((await this.request(`/repos/${config.repository}/pulls/${issue.number}`, signal)).data);
    return githubEventSchema.parse({
      id: `github:${config.repository}:${kind}:${issue.number}`, kind, repository: config.repository,
      number: issue.number, title: issue.title.slice(0, 1000), body: (issue.body ?? "").slice(0, 32_000), bodyTruncated: (issue.body?.length ?? 0) > 32_000,
      url: `https://github.com/${config.repository}/${pr ? "pull" : "issues"}/${issue.number}`,
      author: issue.user?.login ?? "", labels: issue.labels.map(label => typeof label === "string" ? label : label.name),
      createdAt: issue.created_at, updatedAt: issue.updated_at,
      ...(pull ? { headSha: pull.head.sha, headRef: pull.head.ref, baseSha: pull.base.sha, baseRef: pull.base.ref, draft: pull.draft } : {}),
    });
  }
  async poll(config: TriggerConfig, since: string, signal: AbortSignal) {
    const events: GithubEvent[] = [];
    // Overlap protects timestamp boundaries and pagination while repositories change.
    const after = new Date(Date.parse(since) - 120_000).toISOString();
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`/repos/${config.repository}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(after)}&per_page=100&page=${page}`, signal);
      for (const item of z.array(issueSchema).parse(response.data)) {
        const event = await this.event(config, item, signal);
        if (event) events.push(event);
      }
      if (!response.more) return events;
    }
    throw new Error("GitHub polling exceeded 100 pages. The checkpoint was retained; narrow the repository workload before retrying.");
  }
  async item(config: TriggerConfig, number: number, signal: AbortSignal) {
    const event = await this.event(config, (await this.request(`/repos/${config.repository}/issues/${number}`, signal)).data, signal);
    if (!event) throw new Error("This item does not match the trigger's issue/PR event type");
    return event;
  }
  async findComment(event: GithubEvent, marker: string, signal: AbortSignal) {
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`/repos/${event.repository}/issues/${event.number}/comments?per_page=100&page=${page}`, signal);
      const comments = z.array(z.object({ body: z.string(), html_url: z.string().url() })).parse(response.data);
      const found = comments.find(comment => comment.body.includes(marker));
      if (found) return found.html_url;
      if (!response.more) return undefined;
    }
    throw new Error("Could not inspect all result comments; refusing to post a possible duplicate");
  }
  async comment(event: GithubEvent, body: string, signal: AbortSignal) {
    return z.object({ html_url: z.string().url() }).parse((await this.request(`/repos/${event.repository}/issues/${event.number}/comments`, signal, { body })).data).html_url;
  }
}
