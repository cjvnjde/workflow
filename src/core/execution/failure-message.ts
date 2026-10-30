export function failureMessage(error: unknown) {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let value = error;
  while (value instanceof Error && !seen.has(value)) {
    seen.add(value);
    messages.push(value.message);
    value = value.cause;
  }

  return messages.length ? [...new Set(messages)].join(": ") : String(value);
}
