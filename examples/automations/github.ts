import { workflow, block, z, workSignal, discoveryResult, workSignalSchema } from "workflow";

const inputSchema = z.object({
  operation: z.enum(["discover", "work", "report", "publish", "reconcile"]).default("discover"),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  label: z.string().default("workflow-ready"),
  testCommand: z.string().default("bun install --frozen-lockfile && bun run test"),
  testPaths: z.array(z.string()).min(1).default(["tests/**"]),
  alert: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("pull-request") }),
      z.object({ kind: z.literal("issue"), number: z.number().int().positive() }),
    ])
    .default({ kind: "pull-request" }),
  signal: workSignalSchema.optional(),
  case: z
    .object({ currentRevision: z.string(), references: z.record(z.string(), z.string()) })
    .passthrough()
    .optional(),
  automation: z.object({ publicationKey: z.string().optional() }).passthrough().optional(),
  result: z.json().optional(),
});
const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});
const prSchema = z.object({
  number: z.number().int(),
  body: z.string(),
  headRefOid: z.string(),
  headRefName: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});
const checkSchema = z.object({
  id: z.number(),
  conclusion: z.string().nullable(),
  completed_at: z.string().nullable(),
  html_url: z.string(),
  name: z.string(),
});
const reviewSchema = z.object({
  id: z.number(),
  state: z.string(),
  commit_id: z.string(),
  submitted_at: z.string(),
  body: z.string(),
  html_url: z.string(),
});

/** Only nonsecret authored arguments belong here; GH_TOKEN stays in the host environment. */
function shell(command: string, parameters: Record<string, string>) {
  return (
    Object.entries(parameters)
      .map(([name, value]) => {
        if (!/^AUTOMATION_[A-Z_]+$/.test(name) || value.includes("\0"))
          throw new Error("Invalid shell parameter");
        return `${name}='${value.replaceAll("'", "'\\''")}';\n`;
      })
      .join("") + command
  );
}

// These mappings are also exercised offline against an injected external environment.
export function issueSignals(repo: string, value: unknown) {
  return z
    .array(issueSchema)
    .parse(value)
    .map((issue) =>
      workSignal({
        sourceId: `github:${repo}`,
        resourceKey: `issue:${issue.number}`,
        correlationKey: `issue:${issue.number}`,
        signalKind: "issue-ready",
        revision: issue.updatedAt,
        fingerprint: issue.updatedAt,
        observedAt: issue.updatedAt,
        payload: { issue: issue.number, title: issue.title, body: issue.body },
        references: { issue: issue.url },
      }),
    );
}
export function reactionSignals(
  repo: string,
  rawPR: unknown,
  rawChecks: unknown,
  rawReviews: unknown,
) {
  const pr = prSchema.parse(rawPR);
  const match = /<!-- workflow-case:issue:(\d+) -->/.exec(pr.body);
  if (!match) return [];
  const issue = Number(match[1]);
  const common = {
    sourceId: `github:${repo}`,
    resourceKey: `issue:${issue}`,
    correlationKey: `issue:${issue}`,
    revision: pr.headRefOid,
    references: { pr: pr.url, branch: pr.headRefName, head: pr.headRefOid },
  };
  const checks = z.object({ check_runs: z.array(checkSchema) }).parse(rawChecks).check_runs;
  const reviews = z.array(reviewSchema).parse(rawReviews);
  const passed =
    checks.length > 0 &&
    checks.every((check) => check.conclusion === "success" && check.completed_at);
  const completedAt = checks
    .map((check) => check.completed_at ?? "")
    .sort()
    .at(-1)!;
  return [
    // Advance the case to the remotely observed head before routing current-revision feedback.
    workSignal({
      ...common,
      signalKind: "head-observed",
      fingerprint: `head:${pr.headRefOid}`,
      observedAt: pr.updatedAt,
      payload: { issue },
    }),
    ...(passed
      ? [
          workSignal({
            ...common,
            signalKind: "checks-passed",
            fingerprint: `checks-passed:${pr.headRefOid}:${completedAt}:${Math.max(...checks.map((check) => check.id))}`,
            observedAt: completedAt,
            payload: {
              issue,
              checks: checks.length,
              summary: `All ${checks.length} checks passed for ${pr.headRefOid}`,
            },
          }),
        ]
      : []),
    ...checks
      .filter(
        (check) =>
          ["failure", "timed_out", "action_required"].includes(check.conclusion ?? "") &&
          check.completed_at,
      )
      .map((check) =>
        workSignal({
          ...common,
          signalKind: "ci-failed",
          fingerprint: `check:${check.id}:${check.completed_at}`,
          observedAt: check.completed_at!,
          payload: {
            issue,
            feedback: `${check.name}: ${check.conclusion}`,
            evidence: check.html_url,
          },
        }),
      ),
    ...reviews
      .filter(
        (review) => review.state === "CHANGES_REQUESTED" && review.commit_id === pr.headRefOid,
      )
      .map((review) =>
        workSignal({
          ...common,
          signalKind: "review-changes",
          fingerprint: `review:${review.id}`,
          observedAt: review.submitted_at,
          payload: { issue, feedback: review.body, evidence: review.html_url },
        }),
      ),
  ];
}

const discover = block({
  input: inputSchema,
  maxOperations: 100,
  async run(ctx) {
    const env = { AUTOMATION_REPO: ctx.input.repo, AUTOMATION_LABEL: ctx.input.label };
    const issues = await ctx.exec(
      shell(
        'gh issue list --repo "$AUTOMATION_REPO" --label "$AUTOMATION_LABEL" --state open --limit 100 --json number,title,body,updatedAt,url',
        env,
      ),
    );
    if (issues.exitCode !== 0) throw new Error("Issue discovery failed; inspect command evidence");
    const signals = issueSignals(ctx.input.repo, JSON.parse(issues.stdout));
    const prs = await ctx.exec(
      shell(
        'gh pr list --repo "$AUTOMATION_REPO" --state open --limit 20 --json number,body,headRefOid,headRefName,updatedAt,url',
        env,
      ),
    );
    if (prs.exitCode !== 0) throw new Error("PR discovery failed; inspect command evidence");
    const activeCases = new Set<string>();
    for (const pr of z.array(prSchema).parse(JSON.parse(prs.stdout))) {
      const caseMarker = /<!-- workflow-case:issue:(\d+) -->/.exec(pr.body);
      if (!caseMarker) continue;
      activeCases.add(`issue:${caseMarker[1]}`);
      const refs = { ...env, AUTOMATION_SHA: pr.headRefOid, AUTOMATION_PR: String(pr.number) };
      const checks = await ctx.exec(
        shell(
          'gh api "repos/$AUTOMATION_REPO/commits/$AUTOMATION_SHA/check-runs?per_page=100"',
          refs,
        ),
      );
      const reviews = await ctx.exec(
        shell('gh api "repos/$AUTOMATION_REPO/pulls/$AUTOMATION_PR/reviews?per_page=100"', refs),
      );
      if (checks.exitCode !== 0 || reviews.exitCode !== 0)
        throw new Error("Feedback poll failed; checkpoint not advanced");
      signals.push(
        ...reactionSignals(
          ctx.input.repo,
          pr,
          JSON.parse(checks.stdout),
          JSON.parse(reviews.stdout),
        ),
      );
    }
    // Once a PR exists its SHA owns the revision domain; issue comment timestamps must not retire it.
    return discoveryResult({
      signals: signals.filter(
        (signal) => signal.signalKind !== "issue-ready" || !activeCases.has(signal.correlationKey!),
      ),
    });
  },
});

const work = block({
  input: inputSchema,
  maxOperations: 40,
  timeoutMs: 3_600_000,
  async run(ctx) {
    const signal = workSignalSchema.parse(ctx.input.signal);
    const issue = z.number().int().positive().parse(signal.payload.issue);
    const env = { AUTOMATION_REPO: ctx.input.repo, AUTOMATION_ISSUE: String(issue) };
    const detail = await ctx.exec(
      shell(
        'gh issue view "$AUTOMATION_ISSUE" --repo "$AUTOMATION_REPO" --json title,body,url',
        env,
      ),
    );
    if (detail.exitCode !== 0) throw new Error("Cannot read selected issue");
    const continuation =
      signal.signalKind === "ci-failed" || signal.signalKind === "review-changes";
    if (continuation && ctx.input.case?.currentRevision !== signal.revision)
      throw new Error("Feedback no longer matches the current case revision");
    const head = continuation ? signal.revision : ctx.input.case?.references.head;
    if (head) {
      if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid current head revision");
      // This command runs only in the newly reserved owned worktree, never the retained parent.
      const restored = await ctx.exec(
        shell(
          'test -z "$(git status --porcelain)" && git fetch origin "$AUTOMATION_HEAD" && test "$(git rev-parse FETCH_HEAD)" = "$AUTOMATION_HEAD" && git reset --hard "$AUTOMATION_HEAD"',
          { AUTOMATION_HEAD: head },
        ),
      );
      if (restored.exitCode !== 0)
        throw new Error("Cannot verify and restore exact current signal revision");
    }
    const request = `Implement only issue ${issue}: ${detail.stdout}\nCurrent observation: ${JSON.stringify(signal.payload)}`;
    await ctx.ai({
      prompt: request,
      instructions: "Implement the selected issue only. Do not publish, push, open PRs, or merge.",
    });
    await ctx.ai({
      role: "test-author",
      writablePaths: ctx.input.testPaths,
      prompt: `Write focused regression tests for this selected request. Do not alter production code.\n${request}`,
    });
    let feedback = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const tests = await ctx.exec(ctx.input.testCommand, { timeoutMs: 600_000 });
      ctx.artifact(`tests-${attempt}`, tests.output.slice(-30_000));
      if (tests.exitCode === 0 && !tests.timedOut) {
        const reviewed = await ctx.ai({
          role: "review",
          protectedPaths: ["**/*"],
          context: "none",
          prompt: `Independently review the selected change without edits. Inspect the diff and tests; accept only if the issue is implemented and tests substantiate it.\n${request}\nTest evidence:\n${tests.output.slice(-16_000)}`,
          output: z.object({ approved: z.boolean(), feedback: z.string() }),
        });
        if (reviewed.approved) {
          const commit = await ctx.exec(
            'git add -A && if ! git diff --cached --quiet; then git commit -m "Implement selected automation issue"; fi && git rev-parse HEAD',
          );
          if (commit.exitCode !== 0)
            throw new Error("Cannot retain verified implementation commit");
          const sha = commit.stdout.trim().split("\n").at(-1)!;
          if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Invalid retained commit");
          return {
            approved: true,
            issue,
            commit: sha,
            baseRevision: head ?? null,
            feedback: reviewed.feedback,
          };
        }
        feedback = reviewed.feedback;
      } else feedback = tests.output.slice(-16_000);
      if (attempt < 2)
        await ctx.ai({
          role: "repair",
          protectedPaths: ctx.input.testPaths,
          prompt: `Repair production code for the selected request; preserve the regression tests. If tests/infrastructure are invalid, stop and report rather than weaken tests. Do not publish or merge.\n${request}\nFeedback:\n${feedback}`,
        });
    }
    throw new Error(`Bounded repair exhausted: ${feedback.slice(-4000)}`);
  },
});

const publish = block({
  input: inputSchema,
  async run(ctx) {
    const key = z
      .string()
      .regex(/^workflow-automation:[a-f0-9-]+$/)
      .parse(ctx.input.automation?.publicationKey);
    const result = z
      .object({
        approved: z.literal(true),
        issue: z.number().int().positive(),
        commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        baseRevision: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable()
          .default(null),
      })
      .parse(ctx.input.result);
    const marker = `<!-- ${key} -->`;
    const branch =
      ctx.input.case?.references.branch ?? `automation/issue-${result.issue}-${key.slice(-12)}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(branch) || branch.includes(".."))
      throw new Error("Invalid publication branch");
    const env = { AUTOMATION_REPO: ctx.input.repo, AUTOMATION_BRANCH: branch };
    // Query the deterministic branch directly, not GitHub's eventually consistent search index.
    // Always reconcile before mutation, including human retries after an uncertain outcome.
    const prior = await ctx.exec(
      shell(
        'gh pr list --repo "$AUTOMATION_REPO" --state all --head "$AUTOMATION_BRANCH" --limit 100 --json number,body,headRefOid,headRefName,updatedAt,url',
        env,
      ),
    );
    if (prior.exitCode !== 0) throw new Error("Cannot reconcile publication; no write attempted");
    const matches = z
      .array(prSchema)
      .parse(JSON.parse(prior.stdout))
      .filter((pr) => pr.body.includes(marker));
    if (matches.length > 1)
      throw new Error("Ambiguous publication marker; requires human reconciliation");
    let pr = matches[0];
    if (!pr && ctx.input.operation === "reconcile") return { published: false };
    if (!pr) {
      if (ctx.input.case?.references.pr && !result.baseRevision)
        throw new Error("Existing PR update requires the verified base revision");
      const publishEnv = {
        ...env,
        AUTOMATION_COMMIT: result.commit,
        AUTOMATION_BRANCH: branch,
        AUTOMATION_EXPECTED_HEAD: ctx.input.case?.references.pr ? result.baseRevision! : "",
        AUTOMATION_TITLE: `Implement issue #${result.issue}`,
        AUTOMATION_BODY: `Closes #${result.issue}\n\n<!-- workflow-case:issue:${result.issue} -->\n${marker}`,
      };
      const pushed = await ctx.exec(
        shell(
          'git push --force-with-lease="refs/heads/$AUTOMATION_BRANCH:$AUTOMATION_EXPECTED_HEAD" origin "$AUTOMATION_COMMIT:refs/heads/$AUTOMATION_BRANCH"',
          publishEnv,
        ),
      );
      if (pushed.exitCode !== 0)
        throw new Error("Publication push failed; reconcile before retrying");
      // A reaction updates the existing PR, retaining each publication marker for reconciliation.
      const existing = ctx.input.case?.references.pr;
      const created = existing
        ? await ctx.exec(
            shell('gh pr view "$AUTOMATION_PR" --repo "$AUTOMATION_REPO" --json body --jq .body', {
              ...publishEnv,
              AUTOMATION_PR: existing,
            }),
          )
        : await ctx.exec(
            shell(
              'gh pr create --repo "$AUTOMATION_REPO" --head "$AUTOMATION_BRANCH" --title "$AUTOMATION_TITLE" --body "$AUTOMATION_BODY"',
              publishEnv,
            ),
          );
      if (created.exitCode !== 0)
        throw new Error("PR publication uncertain; reconcile before retrying");
      if (existing) {
        const updated = await ctx.exec(
          shell('gh pr edit "$AUTOMATION_PR" --repo "$AUTOMATION_REPO" --body "$AUTOMATION_BODY"', {
            ...publishEnv,
            AUTOMATION_PR: existing,
            AUTOMATION_BODY: `${created.stdout}\n${marker}`,
          }),
        );
        if (updated.exitCode !== 0)
          throw new Error("PR update uncertain; reconcile before retrying");
      }
      const inspected = await ctx.exec(
        shell(
          'gh pr view "$AUTOMATION_BRANCH" --repo "$AUTOMATION_REPO" --json number,body,headRefOid,headRefName,updatedAt,url',
          publishEnv,
        ),
      );
      if (inspected.exitCode !== 0) throw new Error("Cannot confirm published PR");
      pr = prSchema.parse(JSON.parse(inspected.stdout));
    }
    if (pr.headRefOid !== result.commit)
      throw new Error("Published PR head differs from verified commit; inspect remote changes");
    return {
      published: true,
      reference: pr.url,
      signals: [
        workSignal({
          sourceId: `github:${ctx.input.repo}`,
          resourceKey: `issue:${result.issue}`,
          correlationKey: `issue:${result.issue}`,
          signalKind: "published",
          revision: pr.headRefOid,
          fingerprint: key,
          observedAt: pr.updatedAt,
          payload: { issue: result.issue },
          references: { pr: pr.url, branch: pr.headRefName, head: pr.headRefOid },
        }),
      ],
    };
  },
});

const checkReportSchema = z.object({
  kind: z.literal("check-report"),
  issue: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  summary: z.string(),
  references: z.record(z.string(), z.string()),
});
const report = block({
  input: inputSchema,
  run(ctx) {
    const signal = workSignalSchema.parse(ctx.input.signal);
    if (
      signal.signalKind !== "checks-passed" ||
      ctx.input.case?.currentRevision !== signal.revision
    )
      throw new Error("Successful-check report must match the current case revision");
    const result = checkReportSchema.parse({
      kind: "check-report",
      issue: signal.payload.issue,
      revision: signal.revision,
      summary: signal.payload.summary,
      references: signal.references,
    });
    ctx.summary(result.summary);
    return result;
  },
});
const publishReport = block({
  input: inputSchema,
  async run(ctx) {
    const result = checkReportSchema.parse(ctx.input.result);
    if (ctx.input.operation !== "reconcile" && ctx.input.case?.currentRevision !== result.revision)
      throw new Error("Report revision is no longer current");
    const key = z
      .string()
      .regex(/^workflow-automation:[a-f0-9-]+$/)
      .parse(ctx.input.automation?.publicationKey);
    const marker = `<!-- ${key} -->`;
    const pr = /\/pull\/(\d+)$/.exec(result.references.pr ?? "");
    const destination = ctx.input.alert.kind === "issue" ? ctx.input.alert.number : Number(pr?.[1]);
    if (!Number.isSafeInteger(destination) || destination <= 0)
      throw new Error("No configured alert destination");
    const parameters = {
      AUTOMATION_REPO: ctx.input.repo,
      AUTOMATION_DESTINATION: String(destination),
      AUTOMATION_BODY: `${result.summary}\n\nSource: ${result.references.pr}\nRevision: ${result.revision}\n${marker}`,
    };
    const commentSchema = z.object({
      body: z.string(),
      html_url: z.string(),
      created_at: z.string(),
    });
    const prior = await ctx.exec(
      shell(
        'gh api --paginate --slurp "repos/$AUTOMATION_REPO/issues/$AUTOMATION_DESTINATION/comments?per_page=100"',
        parameters,
      ),
    );
    if (prior.exitCode !== 0)
      throw new Error("Cannot reconcile configured alert; no write attempted");
    const matches = z
      .array(z.array(commentSchema))
      .parse(JSON.parse(prior.stdout))
      .flat()
      .filter((comment) => comment.body.includes(marker));
    if (matches.length > 1)
      throw new Error("Ambiguous report marker; requires human reconciliation");
    let comment = matches[0];
    if (!comment && ctx.input.operation === "reconcile") return { published: false };
    if (!comment) {
      const posted = await ctx.exec(
        shell(
          'gh api "repos/$AUTOMATION_REPO/issues/$AUTOMATION_DESTINATION/comments" --method POST --raw-field body="$AUTOMATION_BODY"',
          parameters,
        ),
      );
      if (posted.exitCode !== 0)
        throw new Error("Alert publication uncertain; reconcile before retrying");
      comment = commentSchema.parse(JSON.parse(posted.stdout));
    }
    return {
      published: true,
      reference: comment.html_url,
      signals: [
        workSignal({
          sourceId: `github:${ctx.input.repo}`,
          resourceKey: `issue:${result.issue}`,
          correlationKey: `issue:${result.issue}`,
          signalKind: "checks-reported",
          revision: result.revision,
          fingerprint: key,
          observedAt: comment.created_at,
          payload: { issue: result.issue, summary: result.summary },
          references: { ...result.references, report: comment.html_url },
        }),
      ],
    };
  },
});

export function githubWorkflow(
  operation: "discover" | "work" | "report" | "publish" | "reconcile",
) {
  return workflow({
    name: `GitHub ${operation} (user code)`,
    input: inputSchema,
    async run(ctx) {
      const inputs = { ...ctx.input, operation };
      if (operation === "discover") return ctx.step("discover", discover, { inputs });
      if (operation === "work") return ctx.step("implement-test-review", work, { inputs });
      if (operation === "report") return ctx.step("report-successful-checks", report, { inputs });
      if (checkReportSchema.safeParse(ctx.input.result).success)
        return ctx.step("publish-or-reconcile-report", publishReport, { inputs });
      return ctx.step("publish-or-reconcile", publish, { inputs });
    },
  });
}
export default githubWorkflow("discover");
