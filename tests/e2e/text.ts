type ExpectedText = string | RegExp;

export function matchesValue(actual: string | null, expected: ExpectedText): boolean {
  if (actual === null) return false;
  return typeof expected === "string" ? actual === expected : expected.test(actual);
}

function normalize(text: string): string {
  return text
    .replace(/[\u200b\u00ad]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// String text comparisons ignore DOM whitespace; regular expressions see the
// original text. Arrays describe an exact list or an ordered containing subset.
export function matchesText(
  actual: string[],
  expected: ExpectedText | ExpectedText[],
  contains: boolean,
): boolean {
  const matches = (text: string, value: ExpectedText) => {
    if (typeof value !== "string") return value.test(text);
    return contains
      ? normalize(text).includes(normalize(value))
      : normalize(text) === normalize(value);
  };
  if (!Array.isArray(expected)) {
    // A missing or ambiguous element must not make a negated assertion pass.
    if (actual.length !== 1) throw new Error(`Expected one text element, found ${actual.length}`);
    return matches(actual[0]!, expected);
  }
  if (!contains)
    return (
      actual.length === expected.length &&
      expected.every((value, index) => matches(actual[index]!, value))
    );
  let index = 0;
  for (const text of actual) {
    if (index < expected.length && matches(text, expected[index]!)) index++;
  }
  return index === expected.length;
}
