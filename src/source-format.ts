import { formatWithCursor } from "prettier";
import type { BlockBundle } from "./domain.js";

export type SourceLanguage = "typescript" | "javascript" | "json";

/** Use a fixed style without loading executable project configuration/plugins. */
export async function formatCode(source: string, language: SourceLanguage = "typescript", cursorOffset = 0) {
  return formatWithCursor(source, {
    parser: language === "javascript" ? "babel" : language === "json" ? "json" : "typescript",
    cursorOffset: Math.max(0, Math.min(source.length, cursorOffset)),
    printWidth: 90, tabWidth: 2, trailingComma: "all", singleQuote: false,
  });
}

export async function formatBlock(bundle: BlockBundle): Promise<BlockBundle> {
  const executor = bundle.definition.executor;
  if (executor?.kind !== "code") return bundle;
  return { ...bundle, definition: { ...bundle.definition, executor: { ...executor,
    source: (await formatCode(executor.source)).formatted,
  } } };
}
