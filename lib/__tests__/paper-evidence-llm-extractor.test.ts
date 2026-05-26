import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ParsedPaperEvidenceSection } from "@/lib/paper-evidence-layer";
import {
  buildLlmExtractorUserMessage,
  buildLlmPaperEvidencePromptInput,
  validateLlmPaperEvidenceOutput,
} from "../paper-evidence-llm-extractor";

const fullText = [
  "Abstract",
  "We introduce PlayCoder, a self-evolving coding agent for repository tasks.",
  "The benchmark reports 20.3% Play@3 across 1,978 environments.",
  "Table 1",
  "Game Emulation | MMORPG Games | Desktop Widgets",
  "References",
  "Smith et al. 2026. Prior agent benchmark.",
].join("\n");

const sections: ParsedPaperEvidenceSection[] = [
  {
    sectionIndex: 0,
    sectionPath: ["Abstract"],
    sectionType: "abstract",
    text: [
      "We introduce PlayCoder, a self-evolving coding agent for repository tasks.",
      "The benchmark reports 20.3% Play@3 across 1,978 environments.",
    ].join("\n"),
  },
  {
    sectionIndex: 1,
    sectionPath: ["Results"],
    sectionType: "result",
    text: "Game Emulation | MMORPG Games | Desktop Widgets",
  },
  {
    sectionIndex: 2,
    sectionPath: ["References"],
    sectionType: "references",
    text: "Smith et al. 2026. Prior agent benchmark.",
  },
];

function rangeFor(needle: string) {
  const start = fullText.indexOf(needle);
  if (start < 0) {
    throw new Error(`Missing fixture text: ${needle}`);
  }
  return { start, end: start + needle.length };
}

describe("paper evidence LLM extractor validation", () => {
  it("accepts byte-exact source slices and whitespace-only variants", () => {
    const exact = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const { start, end } = rangeFor(exact);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [
          {
            start,
            end,
            text: "  The benchmark reports 20.3% Play@3 across 1,978 environments.  ",
            section_index: 0,
          },
        ],
        list_table_blocks: [],
        claims: [],
        coined_terms: [],
      },
    });

    expect(result.acceptedSpans).toHaveLength(1);
    expect(result.acceptedSpans[0]).toMatchObject({
      text: exact,
      spanType: "sentence",
      sourceStart: start,
      sourceEnd: end,
      llmRef: 0,
    });
    expect(result.droppedSpanCount).toBe(0);
  });

  it("repairs wrong offsets only when emitted text is a unique exact source substring", () => {
    const exact = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const { start, end } = rangeFor(exact);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [
          {
            start: 0,
            end: exact.length,
            text: exact,
            section_index: 0,
          },
        ],
        list_table_blocks: [],
        claims: [],
        coined_terms: [],
      },
    });

    expect(result.acceptedSpans).toHaveLength(1);
    expect(result.acceptedSpans[0]).toMatchObject({
      sourceStart: start,
      sourceEnd: end,
      text: exact,
    });
    expect(result.droppedSpanCount).toBe(0);
  });

  it("rejects paraphrases, punctuation changes, number changes, and invalid offsets", () => {
    const exact = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const { start, end } = rangeFor(exact);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [
          { start, end, text: exact.replace("reports", "shows"), section_index: 0 },
          { start, end, text: exact.replace("20.3%", "20.4%"), section_index: 0 },
          { start, end, text: exact.replace(".", "!"), section_index: 0 },
          { start: -1, end, text: exact, section_index: 0 },
          { start, end: fullText.length + 10, text: exact, section_index: 0 },
          { start: end, end: start, text: exact, section_index: 0 },
        ],
        list_table_blocks: [],
        claims: [],
        coined_terms: [],
      },
    });

    expect(result.acceptedSpans).toHaveLength(0);
    expect(result.droppedSpanCount).toBe(6);
  });

  it("keeps overlapping list/table blocks whole and deduplicates exact duplicate text", () => {
    const sentence = "Game Emulation | MMORPG Games | Desktop Widgets";
    const { start, end } = rangeFor(sentence);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [
          { start, end, text: sentence, section_index: 1 },
          { start, end, text: sentence, section_index: 1 },
        ],
        list_table_blocks: [
          { start, end, text: sentence, section_index: 1, block_kind: "table" },
        ],
        claims: [],
        coined_terms: [],
      },
    });

    expect(result.acceptedSpans).toHaveLength(2);
    expect(result.acceptedSpans.map((span) => span.spanType)).toEqual([
      "sentence",
      "table_row",
    ]);
    expect(result.acceptedSpans[1].text).toContain("MMORPG Games");
  });

  it("drops references-section spans and dangling claims or coined-term anchors", () => {
    const defining = "We introduce PlayCoder, a self-evolving coding agent for repository tasks.";
    const reference = "Smith et al. 2026. Prior agent benchmark.";
    const definingRange = rangeFor(defining);
    const referenceRange = rangeFor(reference);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [
          { ...definingRange, text: defining, section_index: 0 },
          { ...referenceRange, text: reference, section_index: 2 },
        ],
        list_table_blocks: [],
        claims: [
          {
            claim: "PlayCoder is introduced as a self-evolving coding agent.",
            claim_type: "method",
            primary_support_span_ref: 0,
            support_span_refs: [0],
            confidence: 0.7,
          },
          {
            claim: "Prior work mention should not survive.",
            claim_type: "comparison",
            primary_support_span_ref: 1,
            support_span_refs: [1],
            confidence: 0.9,
          },
        ],
        coined_terms: [
          {
            canonical: "PlayCoder",
            aliases: ["PlayCoder agent"],
            anchor_type: "system",
            support_span_ref: 0,
          },
          {
            canonical: "Prior Agent Benchmark",
            anchor_type: "benchmark",
            support_span_ref: 1,
          },
        ],
      },
    });

    expect(result.acceptedSpans).toHaveLength(1);
    expect(result.droppedSpanCount).toBe(1);
    expect(result.acceptedClaims).toHaveLength(1);
    expect(result.acceptedClaims[0].primarySupportSpanIndex).toBe(0);
    expect(result.acceptedCoinedTermAnchors).toEqual(["PlayCoder", "PlayCoder agent"]);
  });

  it("drops malformed nested claim and anchor fields instead of aborting validation", () => {
    const defining = "We introduce PlayCoder, a self-evolving coding agent for repository tasks.";
    const definingRange = rangeFor(defining);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [{ ...definingRange, text: defining, section_index: 0 }],
        list_table_blocks: [],
        claims: [
          {
            claim: "PlayCoder is a self-evolving coding agent for repository tasks.",
            claim_type: "method",
            primary_support_span_ref: 0,
            confidence: 0.7,
          } as never,
          {
            claim: "Non-array support refs should be dropped.",
            claim_type: "method",
            primary_support_span_ref: 0,
            support_span_refs: "0",
            confidence: 0.7,
          } as never,
          {
            claim: "PlayCoder is introduced as a coding agent for repository tasks.",
            claim_type: "method",
            primary_support_span_ref: 0,
            support_span_refs: [0],
            aliases: "PlayCoder alias",
            confidence: 0.7,
          } as never,
        ],
        coined_terms: [
          {
            canonical: "PlayCoder",
            aliases: "PlayCoder alias",
            anchor_type: "system",
            support_span_ref: 0,
          } as never,
          {
            canonical: null,
            anchor_type: "system",
            support_span_ref: 0,
          } as never,
        ],
      },
    });

    expect(result.acceptedSpans).toHaveLength(1);
    expect(result.acceptedClaims).toHaveLength(2);
    expect(result.acceptedClaims.map((claim) => claim.aliases)).toEqual([[], []]);
    expect(result.droppedClaimCount).toBe(1);
    expect(result.acceptedCoinedTermAnchors).toEqual(["PlayCoder"]);
    expect(result.droppedAnchorCount).toBe(1);
  });

  it("salvages byte-exact nested source_span drift into spans, cards, and anchors", () => {
    const metric = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const metricRange = rangeFor(metric);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [],
        list_table_blocks: [],
        claims: [
          {
            claim: "PlayCoder reports 20.3% Play@3 across 1,978 environments.",
            source_span: {
              ...metricRange,
              text: metric,
            },
            confidence: 0.8,
          } as never,
        ],
        coined_terms: [
          {
            term: "PlayCoder",
            source_span: {
              ...metricRange,
              text: metric,
            },
          } as never,
        ],
      },
    });

    expect(result.acceptedSpans).toHaveLength(1);
    expect(result.acceptedClaims).toHaveLength(1);
    expect(result.acceptedClaims[0]).toMatchObject({
      claimType: "unknown",
      primarySupportSpanIndex: 0,
      supportSpanIndexes: [0],
    });
    expect(result.acceptedCoinedTermAnchors).toEqual(["PlayCoder"]);
  });

  it("drops claim cards whose linked source span does not support the claim", () => {
    const defining = "We introduce PlayCoder, a self-evolving coding agent for repository tasks.";
    const metric = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const definingRange = rangeFor(defining);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [{ ...definingRange, text: defining, section_index: 0 }],
        list_table_blocks: [],
        claims: [
          {
            claim: metric,
            claim_type: "metric",
            primary_support_span_ref: 0,
            support_span_refs: [0],
            confidence: 0.9,
          },
          {
            claim: "PlayCoder is introduced as a coding agent for repository tasks.",
            claim_type: "method",
            primary_support_span_ref: 0,
            support_span_refs: [0],
            confidence: 0.9,
          },
        ],
        coined_terms: [],
      },
    });

    expect(result.acceptedClaims).toHaveLength(1);
    expect(result.acceptedClaims[0].claim).toBe(
      "PlayCoder is introduced as a coding agent for repository tasks.",
    );
    expect(result.droppedClaimCount).toBe(1);
  });

  it("uses an exact source_span fallback when a claim ref points at the wrong span", () => {
    const defining = "We introduce PlayCoder, a self-evolving coding agent for repository tasks.";
    const metric = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const definingRange = rangeFor(defining);
    const metricRange = rangeFor(metric);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [{ ...definingRange, text: defining, section_index: 0 }],
        list_table_blocks: [],
        claims: [
          {
            claim: "The benchmark reports 20.3% Play@3 across 1,978 environments.",
            claim_type: "metric",
            primary_support_span_ref: 0,
            support_span_refs: [],
            source_span: { ...metricRange, text: metric, section_index: 0 },
            confidence: 0.9,
          } as never,
        ],
        coined_terms: [],
      },
    });

    expect(result.acceptedSpans).toHaveLength(2);
    expect(result.acceptedClaims).toHaveLength(1);
    expect(result.acceptedClaims[0]).toMatchObject({
      claimType: "metric",
      primarySupportSpanIndex: 1,
      supportSpanIndexes: [1],
    });
  });

  it("keeps a source_span-backed claim when only auxiliary support refs are bad", () => {
    const metric = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const metricRange = rangeFor(metric);

    const result = validateLlmPaperEvidenceOutput({
      feedItemId: 42,
      fullText,
      sections,
      extraction: {
        propositions: [],
        list_table_blocks: [],
        claims: [
          {
            claim: metric,
            claim_type: "metric",
            primary_support_span_ref: 999,
            support_span_refs: [999],
            source_span: { ...metricRange, text: metric, section_index: 0 },
            confidence: 0.9,
          } as never,
        ],
        coined_terms: [],
      },
    });

    expect(result.acceptedClaims).toHaveLength(1);
    expect(result.acceptedClaims[0]).toMatchObject({
      primarySupportSpanIndex: 0,
      supportSpanIndexes: [0],
    });
  });

  it("treats more than 1,500 emitted source candidates as malformed", () => {
    const exact = "The benchmark reports 20.3% Play@3 across 1,978 environments.";
    const { start, end } = rangeFor(exact);

    expect(() =>
      validateLlmPaperEvidenceOutput({
        feedItemId: 42,
        fullText,
        sections,
        extraction: {
          propositions: Array.from({ length: 1501 }, () => ({
            start,
            end,
            text: exact,
            section_index: 0,
          })),
          list_table_blocks: [],
          claims: [],
          coined_terms: [],
        },
      }),
    ).toThrow(/malformed/i);
  });

  it("builds prompt input from paper metadata and sections without eval labels", () => {
    const promptInput = buildLlmPaperEvidencePromptInput({
      feedItemId: 42,
      title: "PlayCoder",
      externalId: "arxiv:2605.12345",
      fullText,
      sections,
    });

    const serialized = JSON.stringify(promptInput);
    expect(serialized).toContain("PlayCoder");
    expect(serialized).toContain("arxiv:2605.12345");
    expect(serialized).not.toContain("evidence_requirements");
    expect(serialized).not.toContain("must_contain_any");
    expect(serialized).not.toContain("scripts/paper-search-eval-set.json");
  });

  it("keeps eval truth files out of extractor modules", async () => {
    const files = [
      "lib/paper-evidence-layer.ts",
      "lib/paper-evidence-llm-extractor.ts",
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("scripts/paper-search-eval-set.json");
      expect(source).not.toContain("eval/baselines");
      expect(source).not.toContain("evidence_requirements");
    }
  });
});

describe("buildLlmExtractorUserMessage", () => {
  const promptInput = buildLlmPaperEvidencePromptInput({
    feedItemId: 42,
    title: "PlayCoder",
    externalId: "arxiv:2605.12345",
    fullText,
    sections,
  });

  it("starts with the JSON shape header so the model knows the output schema", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message.startsWith("Return exactly this JSON shape:")).toBe(true);
  });

  it("declares the raised proposition budget for full papers", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("aim for 150 to 300 propositions");
    expect(message).not.toContain("aim for 80 to 160 propositions");
  });

  it("directs the model to be exhaustive on numeric, named, and definitional sentences", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("Be exhaustive on propositions");
    expect(message).toContain("numeric result");
    expect(message).toContain("named system/method/dataset/benchmark");
  });

  it("loosens the source-span width target to 5-35 words so short defining spans survive", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("5- to 35-word source spans");
    expect(message).not.toContain("10- to 35-word source spans");
  });

  it("reinforces byte-exact verbatim substring requirement on propositions", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toMatch(
      /byte-exact contiguous substring of full_text/i,
    );
    expect(message).toMatch(/Do not paraphrase/i);
  });

  it("requires named-entity coverage in claim arrays AND coined_terms", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("Named-entity coverage");
    expect(message).toContain(
      "MUST appear in at least one claim's entities/methods/datasets/aliases array",
    );
    expect(message).toContain("AND as a coined_terms entry");
    expect(message).not.toContain(
      "coined_terms should include systems, methods, architectures",
    );
  });

  it("maps named-entity types to specific claim-array slots", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("systems and architectures into entities");
    expect(message).toContain("methods into methods");
    expect(message).toContain("datasets and benchmarks into datasets");
    expect(message).toContain("aliases as well");
  });

  it("requires source_span on every coined_terms entry as a salvage path", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("Every coined_terms entry MUST include a source_span");
    expect(message).toContain("salvage path");
  });

  it("requires whole-sentence preservation overriding the width target", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("Whole-sentence preservation");
    expect(message).toContain("MUST begin at the sentence's actual start");
    expect(message).toContain("Do not start a proposition mid-sentence");
    expect(message).toContain(
      "Do not split a sentence at internal commas",
    );
    expect(message).toContain("are ONE proposition, not several");
    expect(message).toContain(
      "overrides the 5- to 35-word width target",
    );
  });

  it("requires transition and definition sentences even when they are abstract openers", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("Transition and definition sentence coverage");
    expect(message).toContain("introduces a named contribution");
    expect(message).toContain("defines a term");
    expect(message).toContain("states a relationship between a gap and a solution");
    expect(message).toContain("REQUIRED to appear as a verbatim proposition");
  });

  it("appends the serialized paper input JSON after the rules", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).toContain("Paper input JSON:");
    expect(message).toContain(JSON.stringify(promptInput));
  });

  it("does not leak eval truth files or labels into the user message", () => {
    const message = buildLlmExtractorUserMessage(promptInput);
    expect(message).not.toContain("evidence_requirements");
    expect(message).not.toContain("must_contain_any");
    expect(message).not.toContain("scripts/paper-search-eval-set.json");
    expect(message).not.toContain("eval/baselines");
  });
});
