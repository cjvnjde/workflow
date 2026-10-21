import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite } from "./atomic-file.js";
import { resolveAgentSettings, type Library, type WorkflowPlan } from "./domain.js";
import { loadLibrary, validateLibraryResources } from "./library.js";
import { validateCodeBlocks } from "./program-compiler.js";
import { formatBlock } from "./source-format.js";
import { scriptBundle } from "./script-migration.js";
import {
  approvedLibrarySchema, libraryChangesSchema, libraryProposalSchema, modelKey,
  type AvailableModel, type LibraryProposal,
} from "./library-editor-schema.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) { return `[${value.map(canonical).join(",")}]`; }
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const libraryHash = (library: Library) => createHash("sha256").update(canonical(library)).digest("hex");

export function validateModelChoice(settings: ReturnType<typeof resolveAgentSettings>, models: AvailableModel[]) {
  const model = models.find((entry) => entry.provider === settings.provider && entry.id === settings.model);
  if (!model) { throw new Error(`Model is not available: ${settings.provider ?? "unset"}/${settings.model ?? "unset"}. Refresh models or connect its provider.`); }
  if (!model.thinkingLevels.includes(settings.thinking)) { throw new Error(`Thinking level ${settings.thinking} is not supported by ${modelKey(model)}`); }
}

export function validatePlanModels(plan: WorkflowPlan, library: Library, models: AvailableModel[]) {
  for (const node of plan.nodes) {
    const executor = library.blocks[node.block]?.definition.executor;
    if (executor && (executor.kind !== "code" || !node.agent)) { continue; }
    validateModelChoice(resolveAgentSettings(library.config.agent, library.blocks[node.block]?.definition.agent, node.agent), models);
  }
  return plan;
}

export function validateLibraryChanges(value: unknown, library: Library, kind: LibraryProposal["kind"], models: AvailableModel[]) {
  const changes = libraryChangesSchema.parse(value);
  for (const change of changes.blocks) change.bundle = scriptBundle(change.bundle, library.config.commands);
  const blocks = structuredClone(library.blocks);
  const ids = new Set<string>();
  const removed = new Set(changes.remove ?? []);
  if (removed.size !== (changes.remove?.length ?? 0)) { throw new Error("Duplicate block removal"); }
  if (kind === "models" && removed.size) { throw new Error("Model-only updates cannot remove blocks"); }
  for (const id of removed) {
    if (!blocks[id]) { throw new Error(`Unknown block to remove: ${id}`); }
    delete blocks[id];
  }
  for (const { bundle } of changes.blocks) {
    const id = bundle.definition.id;
    if (removed.has(id)) { throw new Error(`Cannot update and remove block ${id} in the same proposal`); }
    if (ids.has(id)) { throw new Error(`Duplicate block: ${id}`); }
    ids.add(id);
    if (kind === "models") {
      const current = library.blocks[id];
      const withoutAgent = (entry: typeof bundle) => ({ ...entry, definition: { ...entry.definition, agent: undefined } });
      if (!current || !isDeepStrictEqual(withoutAgent(current), withoutAgent(bundle)) ||
          !isDeepStrictEqual(current.definition.agent?.timeoutMs, bundle.definition.agent?.timeoutMs) ||
          !isDeepStrictEqual(current.definition.agent?.maxToolCalls, bundle.definition.agent?.maxToolCalls)) {
        throw new Error("Model-only updates must preserve block instructions, checks, resources and execution limits");
      }
    }
    const agent = bundle.definition.agent;
    if (kind !== "manual" && !bundle.definition.executor && (!agent?.provider || !agent.model || !agent.thinking)) { throw new Error(`AI-generated block ${id} must explicitly select provider, model and thinking`); }
    if (kind === "regenerate" && library.blocks[id]?.definition.outputs.some((output) => !bundle.definition.outputs.includes(output))) {
      throw new Error(`Regenerated block ${id} must preserve existing output contracts`);
    }
    if (!bundle.definition.executor && (kind !== "manual" || agent?.provider || agent?.model || agent?.thinking)) {
      validateModelChoice(resolveAgentSettings(library.config.agent, agent), models);
    }
    blocks[id] = bundle;
  }
  if (kind === "models" && (ids.size !== Object.keys(library.blocks).length || Object.keys(library.blocks).some((id) => !ids.has(id)))) {
    throw new Error("Model-only updates must include every existing block");
  }
  validateLibraryResources(blocks, library.config.commands);
  return { changes, blocks };
}

export class LibraryProposals {
  private mutations = Promise.resolve();
  constructor(private readonly project: string) {}
  private async mutate<T>(action: () => Promise<T>) {
    const result = this.mutations.then(action);
    this.mutations = result.then(() => {}, () => {});
    return await result;
  }
  private filename(id: string) { return path.join(this.project, ".workflow", "library-proposals", `${libraryProposalSchema.shape.id.parse(id)}.json`); }
  private removedBlockFiles(ids: readonly string[] = []) {
    // JSON edits retain directory-backed source. Removed modules must not
    // resolve to those old files when validating the remaining dependencies.
    return new Set(ids.map(id => path.resolve(this.project, ".workflow", "blocks", id, "block.ts")));
  }
  private async save(proposal: LibraryProposal) {
    const filename = this.filename(proposal.id);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(path.dirname(filename), ".gitignore"), "*\n");
    await atomicWrite(filename, JSON.stringify(libraryProposalSchema.parse(proposal)) + "\n");
  }
  async get(id: string) { return libraryProposalSchema.parse(JSON.parse(await readFile(this.filename(id), "utf8"))); }
  async create(library: Library, kind: LibraryProposal["kind"], value: unknown, models: AvailableModel[]) {
    const { changes, blocks } = validateLibraryChanges(value, library, kind, models);
    for (const change of changes.blocks) {
      change.bundle = await formatBlock(change.bundle);
      blocks[change.bundle.definition.id] = change.bundle;
    }
    await validateCodeBlocks(this.project, blocks, this.removedBlockFiles(changes.remove));
    const proposal: LibraryProposal = { id: randomUUID(), createdAt: new Date().toISOString(), status: "draft", kind, baseHash: libraryHash(library), changes, allowedModels: models.map(modelKey) };
    await this.save(proposal);
    return proposal;
  }
  async apply(id: string, models: AvailableModel[]) {
    return await this.mutate(async () => {
      const proposal = await this.get(id);
      if (proposal.status === "rejected") { throw new Error("Only draft library changes can be applied"); }
      const current = await loadLibrary(this.project);
      if (proposal.appliedHash && libraryHash(current) === proposal.appliedHash) {
        proposal.status = "applied"; await this.save(proposal); return proposal;
      }
      if (proposal.status !== "draft") { throw new Error("This proposal was already applied and the library has since changed"); }
      if (libraryHash(current) !== proposal.baseHash) { throw new Error("The library or project defaults changed. Generate a new proposal to preserve those edits."); }
      const allowed = proposal.kind === "manual" ? models : models.filter((model) => proposal.allowedModels.includes(modelKey(model)));
      const { blocks } = validateLibraryChanges(proposal.changes, current, proposal.kind, allowed);
      await validateCodeBlocks(this.project, blocks, this.removedBlockFiles(proposal.changes.remove));
      proposal.appliedHash = libraryHash({ config: current.config, blocks });
      // Persist the intended final fingerprint so a retry can recognize an interrupted publication.
      await this.save(proposal);
      const directory = path.join(this.project, ".workflow", "libraries");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(directory, ".gitignore"), "*\n");
      await atomicWrite(path.join(directory, `${proposal.baseHash}.json`), JSON.stringify(approvedLibrarySchema.parse({ version: 1, blocks: current.blocks })) + "\n");
      await atomicWrite(path.join(this.project, ".workflow", "library.json"), JSON.stringify(approvedLibrarySchema.parse({ version: 1, blocks }), null, 2) + "\n", 0o600, async () => {
        if (libraryHash(await loadLibrary(this.project)) !== proposal.baseHash) { throw new Error("The library changed while applying. Generate a new proposal."); }
      });
      proposal.status = "applied";
      await this.save(proposal);
      return proposal;
    });
  }
  async reject(id: string) {
    return await this.mutate(async () => {
      const proposal = await this.get(id);
      if (proposal.status !== "draft") { throw new Error("Only draft library changes can be rejected"); }
      if (proposal.appliedHash && libraryHash(await loadLibrary(this.project)) === proposal.appliedHash) { throw new Error("This library proposal was already applied"); }
      proposal.status = "rejected";
      await this.save(proposal);
      return proposal;
    });
  }
  async removeBlock(id: string, revision: string) {
    return await this.mutate(async () => {
      const library = await loadLibrary(this.project);
      if (libraryHash(library) !== revision) { throw new Error("The block library changed. Reload before removing a block."); }
      if (!library.blocks[id]) { throw new Error("Block not found"); }
      const blocks = { ...library.blocks }; delete blocks[id];
      validateLibraryResources(blocks, library.config.commands);
      await validateCodeBlocks(this.project, blocks, this.removedBlockFiles([id]));
      const directory = path.join(this.project, ".workflow", "libraries");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(directory, `${revision}.json`), JSON.stringify({ version: 1, blocks: library.blocks }));
      await atomicWrite(path.join(this.project, ".workflow", "library.json"), JSON.stringify(approvedLibrarySchema.parse({ version: 1, blocks }), null, 2) + "\n", 0o600, async () => {
        if (libraryHash(await loadLibrary(this.project)) !== revision) { throw new Error("The library changed while removing a block"); }
      });
      return { removed: true };
    });
  }
}
