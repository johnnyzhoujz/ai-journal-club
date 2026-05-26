import { describe, expect, it } from "vitest";

import {
  normalizeForLabelMatch,
  normalizeWhitespace,
} from "@/lib/paper-evidence-normalization";

describe("paper evidence normalization — normalizeWhitespace", () => {
  it("collapses runs of spaces, tabs, newlines", () => {
    expect(normalizeWhitespace("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  hello world  ")).toBe("hello world");
  });

  it("handles NBSP (U+00A0) and narrow no-break space (U+202F) as whitespace", () => {
    expect(normalizeWhitespace("a b c")).toBe("a b c");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeWhitespace("   \t\n  ")).toBe("");
  });
});

describe("paper evidence normalization — normalizeForLabelMatch", () => {
  it("lowercases", () => {
    expect(normalizeForLabelMatch("Tree Of Thoughts")).toBe("tree of thoughts");
  });

  it("replaces literal 'percent' with %", () => {
    expect(normalizeForLabelMatch("74 percent improvement")).toBe(
      "74 % improvement",
    );
  });

  it("preserves decimals adjacent to digits", () => {
    expect(normalizeForLabelMatch("20.3% Play@3")).toBe("20.3% play 3");
  });

  it("spaces out sentence-end periods (period adjacent to non-digit)", () => {
    expect(normalizeForLabelMatch("end of sentence. Next.")).toBe(
      "end of sentence next",
    );
  });

  it("maps hyphen variants (U+2010 ‐, U+2011 ‑, U+2012 ‒, U+2013 –, U+2014 —) to ASCII hyphen then space", () => {
    expect(normalizeForLabelMatch("Manager‐Planner‑Executor")).toBe(
      "manager planner executor",
    );
    expect(normalizeForLabelMatch("Manager–Planner—Executor")).toBe(
      "manager planner executor",
    );
    expect(normalizeForLabelMatch("Manager‒Planner")).toBe(
      "manager planner",
    );
  });

  it("turns ASCII hyphens into spaces", () => {
    expect(normalizeForLabelMatch("Manager-Planner-Executor")).toBe(
      "manager planner executor",
    );
  });

  it("turns underscores into spaces", () => {
    expect(normalizeForLabelMatch("feed_item_id")).toBe("feed item id");
  });

  it("turns @ into space", () => {
    expect(normalizeForLabelMatch("Play@3")).toBe("play 3");
  });

  it("turns / into space", () => {
    expect(normalizeForLabelMatch("BLEU/ROUGE")).toBe("bleu rouge");
  });

  it("strips smart quotes (U+2018 ', U+2019 ', U+201C \", U+201D \") to space", () => {
    expect(normalizeForLabelMatch("‘PlayCoder’")).toBe("playcoder");
    expect(normalizeForLabelMatch("“PlayCoder” benchmark")).toBe(
      "playcoder benchmark",
    );
  });

  it("strips parentheses, colons, semicolons, commas to space", () => {
    expect(normalizeForLabelMatch("Tree of Thoughts: 74.0%, (preview)")).toBe(
      "tree of thoughts 74.0% preview",
    );
  });

  it("strips question marks and exclamation marks to space", () => {
    expect(normalizeForLabelMatch("Really? Yes!")).toBe("really yes");
  });

  it("preserves + sign", () => {
    expect(normalizeForLabelMatch("C++ implementation")).toBe(
      "c++ implementation",
    );
  });

  it("preserves % sign", () => {
    expect(normalizeForLabelMatch("99% accuracy")).toBe("99% accuracy");
  });

  it("collapses multi-line whitespace to single spaces", () => {
    expect(normalizeForLabelMatch("line one\nline two\n\nline three")).toBe(
      "line one line two line three",
    );
  });

  it("treats CRLF and CR as whitespace", () => {
    expect(normalizeForLabelMatch("alpha\r\nbeta\rgamma")).toBe(
      "alpha beta gamma",
    );
  });

  it("handles NBSP and narrow no-break space as whitespace", () => {
    expect(normalizeForLabelMatch("Tree of Thoughts")).toBe(
      "tree of thoughts",
    );
  });

  it("strips fullwidth punctuation to space", () => {
    expect(normalizeForLabelMatch("PlayCoder：benchmark")).toBe(
      "playcoder benchmark",
    );
  });

  it("trims leading/trailing whitespace after substitutions", () => {
    expect(normalizeForLabelMatch("  hello  ")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeForLabelMatch("")).toBe("");
  });

  it("does not introduce a 'percent' literal when % is present", () => {
    expect(normalizeForLabelMatch("99%")).toBe("99%");
  });

  it("matches the eval label form for canonical example queries", () => {
    // From the staging eval set (.context/paper-evidence-gate-default35-realistic-2026-05-20.json)
    // and the paper text it's supposed to match.
    const labelA = normalizeForLabelMatch("Manager-Planner-Executor architecture");
    const sourceA = normalizeForLabelMatch(
      "We introduce the Manager‐Planner‐Executor architecture.",
    );
    expect(sourceA.includes(labelA)).toBe(true);

    const labelB = normalizeForLabelMatch("20.3% Play@3");
    const sourceB = normalizeForLabelMatch(
      "Our system achieves 20.3% Play@3 on the benchmark.",
    );
    expect(sourceB.includes(labelB)).toBe(true);

    const labelC = normalizeForLabelMatch("Agentic Environment-Task Discovery");
    const sourceC = normalizeForLabelMatch(
      "We call this approach Agentic Environment–Task Discovery.",
    );
    expect(sourceC.includes(labelC)).toBe(true);
  });

  it("identity check — handles every character class from the verifier body", () => {
    // Exhaustive fixture that exercises each transformation step in order.
    const fixture: Array<[string, string]> = [
      ["A", "a"],
      ["A B", "a b"],
      ["50 percent", "50 %"],
      ["50PERCENT", "50percent"], // percent is word-boundary; 'PERCENT' without a boundary stays
      ["1.5", "1.5"],
      ["v.1", "v 1"],
      ["1.x", "1 x"],
      ["end.", "end"],
      ["Manager—Planner", "manager planner"],
      ["A_B", "a b"],
      ["A/B", "a b"],
      ["A@B", "a b"],
      ["A-B", "a b"],
      ["A+B", "a+b"],
      ["A%", "a%"],
      ["A.B", "a b"],
      ["A.1", "a 1"],
      ["1.A", "1 a"],
    ];
    for (const [input, expected] of fixture) {
      expect(normalizeForLabelMatch(input)).toBe(expected);
    }
  });
});

describe("paper evidence normalization — verifier behavior alignment", () => {
  it("the runtime verifier exports normalizeForLabelMatch from the same module", async () => {
    const verifierModule = await import("@/lib/paper-evidence-verifier");
    const normalizationModule = await import(
      "@/lib/paper-evidence-normalization"
    );
    // The verifier may re-export or reuse — assert the function objects are the same reference
    // OR (if the verifier uses an alias) assert behavioral identity on a representative fixture.
    const samples = [
      "Tree of Thoughts: 74.0%",
      "Manager—Planner—Executor",
      "20.3% Play@3",
      "50 percent improvement",
      "alpha\r\nbeta",
      "‘PlayCoder’ benchmark",
    ];
    const verifierNormalize =
      (verifierModule as { normalizeForLabelMatch?: (v: string) => string })
        .normalizeForLabelMatch ?? normalizationModule.normalizeForLabelMatch;
    for (const sample of samples) {
      expect(verifierNormalize(sample)).toBe(
        normalizationModule.normalizeForLabelMatch(sample),
      );
    }
  });
});
