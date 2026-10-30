/** Explicit demo-mode values only; never used by live model execution. */
export function demoData(
  schema: Record<string, unknown>,
  summary: string,
  retry: boolean,
  key = "",
  root = schema,
  depth = 0,
): unknown {
  if (depth > 12) throw new Error("Demo output schema is too deeply nested");
  const next = (value: unknown, name = key) =>
    demoData(value as Record<string, unknown>, summary, retry, name, root, depth + 1);
  if (typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#/")) throw new Error("Demo output references must be local");
    let target: unknown = root;
    for (const part of schema.$ref.slice(2).split("/"))
      target = (target as Record<string, unknown>)?.[
        part.replaceAll("~1", "/").replaceAll("~0", "~")
      ];
    if (!target) throw new Error("Unresolved demo output schema reference");
    return next(target);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum))
    return key === "outcome" && schema.enum.includes(retry ? "retry" : "pass")
      ? retry
        ? "retry"
        : "pass"
      : schema.enum[0];
  if (Array.isArray(schema.anyOf))
    return next(schema.anyOf.find((item) => item.type !== "null") ?? schema.anyOf[0]);
  switch (schema.type) {
    case "object":
      return Object.fromEntries(
        Object.entries((schema.properties ?? {}) as Record<string, unknown>).map(
          ([name, value]) => [name, next(value, name)],
        ),
      );
    case "array": {
      const size = typeof schema.minItems === "number" ? schema.minItems : 0;
      if (size > 30) throw new Error("Demo output array is too large");
      return Array.from({ length: size }, () => next(schema.items ?? {}));
    }
    case "boolean":
      return ["approved", "passed"].includes(key) ? !retry : true;
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "null":
      return null;
    case "string": {
      const length = typeof schema.minLength === "number" ? schema.minLength : 0;
      if (length > 16_000) throw new Error("Demo output string is too large");
      return summary
        .padEnd(length, ".")
        .slice(0, typeof schema.maxLength === "number" ? schema.maxLength : 16_000);
    }
    default:
      return {};
  }
}
