import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import temporalPackage from "@temporalio/worker/package.json";
import { z } from "zod";
import { atomicWrite } from "./atomic-file.js";

export const temporalSdkVersion = temporalPackage.version;
const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    sdkVersion: z.string(),
    protocol: z.literal(2),
    toolsHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type WorkflowVersion = z.infer<typeof manifestSchema>;

export class WorkflowVersions {
  constructor(private readonly directory: string) {}

  async install(bundlePath: string, tools?: string): Promise<WorkflowVersion> {
    const code = await readFile(bundlePath);
    const toolsHash =
      tools === undefined ? undefined : createHash("sha256").update(tools).digest("hex");
    const hash = createHash("sha256").update(code);
    if (toolsHash) hash.update(`\nworkflow-tools:${toolsHash}`);
    const id = hash.digest("hex");
    const manifest = manifestSchema.parse({
      id,
      sdkVersion: temporalSdkVersion,
      protocol: 2,
      toolsHash,
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.directory, ".gitignore"), "*\n");
    const directory = path.join(this.directory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(directory, "workflow-bundle.js"), code);
    if (tools !== undefined) await atomicWrite(path.join(directory, "tools.js"), tools);
    await atomicWrite(path.join(directory, "manifest.json"), JSON.stringify(manifest) + "\n");
    return manifest;
  }

  async load(id: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(id);
    const directory = path.join(this.directory, id);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
    );
    if (manifest.id !== id || manifest.sdkVersion !== temporalSdkVersion) {
      throw new Error(
        `Workflow version ${id.slice(0, 12)} requires Temporal SDK ${manifest.sdkVersion}. Keep its compatible runtime until these runs finish.`,
      );
    }
    const codePath = path.join(directory, "workflow-bundle.js");
    const hash = createHash("sha256").update(await readFile(codePath));
    const toolsPath = manifest.toolsHash ? path.join(directory, "tools.js") : undefined;
    if (manifest.toolsHash) {
      if (
        createHash("sha256")
          .update(await readFile(toolsPath!))
          .digest("hex") !== manifest.toolsHash
      )
        throw new Error(`Workflow tool archive ${id.slice(0, 12)} is corrupt`);
      hash.update(`\nworkflow-tools:${manifest.toolsHash}`);
    }
    if (hash.digest("hex") !== id) {
      throw new Error(
        `Workflow version ${id.slice(0, 12)} is corrupt. Restore .workflow/versions from backup.`,
      );
    }
    return { ...manifest, codePath, toolsPath };
  }
}
