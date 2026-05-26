export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeForLabelMatch(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/\bpercent\b/g, "%")
      .replace(/(\D)\./g, "$1 ")
      .replace(/\.(\D|$)/g, " $1")
      .replace(/[‐‑‒–—]/g, "-")
      .replace(/[@/_-]/g, " ")
      .replace(/[^a-z0-9+.%\s]/g, " "),
  );
}
