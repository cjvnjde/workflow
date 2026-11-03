import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runSchema, type WorkflowRun } from "../../contracts/domain.js";
import {
  automationRunOwnershipSchema,
  type AutomationRunOwnership,
} from "../../contracts/automation-schema.js";
import type { AutomationLimit } from "../../infrastructure/automation-boundary.js";
import { atomicWrite } from "../../infrastructure/atomic-file.js";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execute("git", args, { cwd, timeout: 30_000, maxBuffer: 1_000_000 })).stdout.trim();
type Metadata = NonNullable<WorkflowRun["automation"]>;
const markerSchema = z
  .object({
    runId: z.uuid(),
    metadata: runSchema.shape.automation.unwrap(),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    base: z.string(),
    state: z.enum(["reserved", "ready", "removing", "removed"]),
    counters: z
      .object({
        commands: z.number().int().nonnegative(),
        models: z.number().int().nonnegative(),
        tools: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
type Marker = z.infer<typeof markerSchema>;
export function automationDigest(value: unknown): string {
  const stable = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(stable)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([, value]) => value !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, stable(value)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
/** Host-owned reservation and conservative Git cleanup. A worktree is isolation, not a security sandbox. */
export class ManagedWorkspaces {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly project: string) {}
  private async directory() {
    const root = await realpath(this.project);
    for (const part of [".workflow", ".workflow/automation-workspaces"]) {
      const directory = path.join(root, part);
      await mkdir(directory, { recursive: true });
      if ((await realpath(directory)) !== directory || (await lstat(directory)).isSymbolicLink())
        throw new Error("Automation storage must not use symlinks");
    }
    return path.join(root, ".workflow", "automation-workspaces");
  }
  private async filename(id: string) {
    z.uuid().parse(id);
    return path.join(await this.directory(), `${id}.json`);
  }
  private async load(id: string): Promise<Marker> {
    const marker = markerSchema.parse(JSON.parse(await readFile(await this.filename(id), "utf8")));
    if (marker.runId !== id) throw new Error("Automation reservation identity mismatch");
    return marker;
  }
  private async save(marker: Marker) {
    await atomicWrite(await this.filename(marker.runId), JSON.stringify(marker));
  }
  async reserve(
    id: string,
    raw: AutomationRunOwnership,
    snapshot: unknown,
    previous?: WorkflowRun,
  ): Promise<Metadata> {
    const owner = automationRunOwnershipSchema.parse(raw);
    if (owner.workspace !== owner.execution.workspace || owner.baseRef !== owner.execution.baseRef)
      throw new Error("Automation ownership policy mismatch");
    const project = await realpath(this.project),
      directory = await this.directory();
    const branch =
      owner.workspace === "worktree" ? `workflow/automation/${owner.jobId}/${id}` : undefined;
    const metadata: Metadata = {
      automationId: owner.automationId,
      jobId: owner.jobId,
      workspace: owner.workspace,
      root: branch ? path.join(directory, id) : project,
      branch,
      reservation: automationDigest({ owner, snapshot }),
      execution: owner.execution,
    };
    let marker: Marker;
    try {
      marker = await this.load(id);
      if (automationDigest(marker.metadata) !== automationDigest(metadata))
        throw new Error("Automation reservation does not match frozen run policy");
      if (marker.state === "removed" || marker.state === "removing")
        throw new Error("Automation workspace has already been cleaned or cleanup is pending");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let base: string;
      if (owner.workspace === "project") base = "";
      else if (owner.previousRunId) {
        if (
          !previous?.automation ||
          previous.id !== owner.previousRunId ||
          previous.automation.automationId !== owner.automationId
        )
          throw new Error("Continuation workspace must be owned by the same automation", {
            cause: error,
          });
        await this.assert(previous.id, previous.automation);
        if (await git(previous.automation.root, "status", "--porcelain", "--untracked-files=all"))
          throw new Error(
            "Commit prior automation work before starting a continuation; dirty evidence is retained",
            { cause: error },
          );
        base = await git(previous.automation.root, "rev-parse", "--verify", "HEAD^{commit}");
      } else base = await git(project, "rev-parse", "--verify", `${owner.baseRef}^{commit}`);
      marker = {
        runId: id,
        metadata,
        snapshot: automationDigest(snapshot),
        base,
        state: "reserved",
        counters: { commands: 0, models: 0, tools: 0 },
      };
      const file = await open(await this.filename(id), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(marker));
        await file.sync();
      } finally {
        await file.close();
      }
    }
    if (marker.state === "reserved") {
      if (branch) {
        let exists = true;
        try {
          await lstat(metadata.root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          exists = false;
        }
        if (!exists) {
          let existingBranch = false;
          try {
            await git(project, "show-ref", "--verify", `refs/heads/${branch}`);
            existingBranch = true;
          } catch {
            /* A crash can leave the branch before the worktree. */
          }
          if (existingBranch) {
            if ((await git(project, "rev-parse", branch)) !== marker.base)
              throw new Error("Reserved branch changed before worktree creation");
            await git(project, "worktree", "add", metadata.root, branch);
          } else await git(project, "worktree", "add", "-b", branch, metadata.root, marker.base);
        }
      }
      await this.validate(metadata, marker);
      marker.state = "ready";
      await this.save(marker);
    }
    await this.validate(metadata, marker);
    return metadata;
  }
  private async validate(metadata: Metadata, marker: Marker) {
    if (
      automationDigest(marker.metadata) !== automationDigest(metadata) ||
      marker.state === "removed"
    )
      throw new Error("Automation workspace ownership mismatch");
    const project = await realpath(this.project),
      expected =
        metadata.workspace === "project"
          ? project
          : path.join(await this.directory(), marker.runId);
    if (metadata.root !== expected || (await realpath(expected)) !== expected)
      throw new Error("Automation workspace path escape");
    if (metadata.workspace === "project") return;
    const common = async (root: string) =>
      realpath(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    if (
      (await common(project)) !== (await common(expected)) ||
      (await realpath(await git(expected, "rev-parse", "--show-toplevel"))) !== expected
    )
      throw new Error("Automation workspace belongs to another repository");
    if (
      metadata.branch &&
      (await git(expected, "symbolic-ref", "--short", "HEAD")) !== metadata.branch
    )
      throw new Error("Automation workspace branch ownership changed");
  }
  async assert(id: string, metadata: Metadata, snapshot?: unknown) {
    const marker = await this.load(id);
    if (marker.state !== "ready")
      throw new Error("Automation workspace ownership is not executable");
    if (snapshot !== undefined && marker.snapshot !== automationDigest(snapshot))
      throw new Error("Automation run no longer matches its frozen reservation");
    await this.validate(metadata, marker);
    return metadata.root;
  }
  async consume(id: string, metadata: Metadata, kind: AutomationLimit) {
    const operation = this.writes.then(async () => {
      const marker = await this.load(id);
      if (
        marker.state !== "ready" ||
        automationDigest(metadata) !== automationDigest(marker.metadata)
      )
        throw new Error("Automation reservation is not executable");
      await this.validate(metadata, marker);
      const limit = {
        commands: metadata.execution.maxCommands,
        models: metadata.execution.maxModelCalls,
        tools: metadata.execution.maxToolCalls,
      }[kind];
      if (marker.counters[kind] >= limit)
        throw new Error(`Automation ${kind} limit exhausted (${limit})`);
      marker.counters[kind]++;
      await this.save(marker);
    });
    this.writes = operation.catch(() => {});
    await operation;
  }
  async cleanup(id: string, metadata: Metadata) {
    const marker = await this.load(id);
    if (automationDigest(marker.metadata) !== automationDigest(metadata))
      throw new Error("Automation workspace ownership mismatch");
    if (marker.state === "removed") return;
    if (marker.state === "removing") {
      try {
        await lstat(metadata.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (
          (await git(this.project, "worktree", "list", "--porcelain"))
            .split("\n")
            .includes(`worktree ${metadata.root}`)
        )
          throw new Error(
            "Interrupted cleanup still has a Git worktree registration; inspect it before removal",
            { cause: error },
          );
        marker.state = "removed";
        await this.save(marker);
        return;
      }
    }
    await this.validate(metadata, marker);
    if (metadata.workspace === "project") throw new Error("Project workspaces are never removed");
    if (
      await git(
        metadata.root,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
      )
    )
      throw new Error("Refusing to clean a dirty automation workspace");
    if (await git(metadata.root, "rev-list", "HEAD", "--not", "--remotes"))
      throw new Error("Refusing to clean an unpublished automation branch");
    marker.state = "removing";
    await this.save(marker);
    await git(this.project, "worktree", "remove", metadata.root);
    // Keep the branch as durable published evidence; never force-delete it.
    marker.state = "removed";
    await this.save(marker);
  }
}
