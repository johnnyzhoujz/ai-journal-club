import { describe, expect, it } from "vitest";

import {
  extractPaperEvidenceClaimTerms,
  verifyPaperEvidenceChunks,
} from "@/lib/paper-evidence-verifier";
import type { MemorySearchChunkHit } from "@/lib/schema";

function makeHit(
  id: number,
  feedItemId: number,
  snippet: string,
  text = snippet,
  overrides: Partial<MemorySearchChunkHit> = {},
): MemorySearchChunkHit & { text: string } {
  return {
    kind: "chunk",
    id,
    feed_item_id: feedItemId,
    source_type: "paper",
    title: "Tree of Thoughts",
    author_name: "Research Team",
    published_at: null,
    url: "https://example.com/paper",
    snippet,
    text,
    entity_labels: [],
    ...overrides,
  };
}

describe("paper evidence verifier", () => {
  it("extracts required claim terms without corpus/meta words", () => {
    const terms = extractPaperEvidenceClaimTerms(
      "What did the paper report for Tree of Thoughts on Game-of-24 benchmark at 74.0%?",
    ).map((term) => term.normalized);

    expect(terms).toEqual(
      expect.arrayContaining(["tree of thoughts", "game of 24", "74.0%"]),
    );
    expect(terms).not.toContain("paper");
    expect(terms).not.toContain("benchmark");
  });

  it("marks direct evidence chunks as supports", () => {
    const verification = verifyPaperEvidenceChunks({
      query:
        "Which paper reports Tree of Thoughts 74.0% score on Game-of-24?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(
          1,
          10,
          "Tree of Thoughts reaches a 74.0% score on Game-of-24 tasks.",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
    expect(verification.metadata.supporting_chunk_ids).toEqual([1]);
  });

  it("marks right paper wrong chunk as paper_related_only", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "Which paper reports a 91.2% accuracy on SWE-bench Verified?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(1, 10, "This section describes a broad coding benchmark."),
      ],
    });

    expect(verification.metadata.status).toBe("paper_related_only");
    expect(verification.metadata.related_chunk_ids).toEqual([1]);
    expect(verification.metadata.supporting_chunk_ids).toEqual([]);
  });

  it("requires concrete anchors for Kubernetes PSP migration claims", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "Which paper covers Kubernetes PSP migration?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(
          1,
          10,
          "The paper discusses Kubernetes policy migration for cluster administrators.",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("paper_related_only");
    expect(verification.chunks[0].missingAnchorGroups).toContain(
      "pod security policy",
    );
    expect(verification.chunks[0].reason).toContain(
      "concrete anchors not matched",
    );
  });

  it("matches percent detail anchors through normalized numeric evidence", () => {
    const verification = verifyPaperEvidenceChunks({
      query:
        "Claw-Eval-Live leading model passes only 66.7 percent of workflow tasks",
      candidateFeedItemIds: [1831],
      hits: [
        makeHit(
          1,
          1831,
          "The leading model passes only 66.7% of tasks and no model reaches 70%.",
          "Experiments reveal that reliable workflow automation remains far from solved: the leading model passes only 66.7% of tasks and no model reaches 70%.",
          {
            title:
              "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
          },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
    expect(verification.metadata.supporting_chunk_ids).toEqual([1]);
  });

  it("supports PlayCoder Claude Sonnet Play@3 results with normalized detail anchors", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "PlayCoder reaches 20.3 percent Play@3 with Claude Sonnet 4",
      candidateFeedItemIds: [5425],
      hits: [
        makeHit(
          1,
          5425,
          "With Claude-Sonnet-4, PlayCoder reaches 36.8% Exec@3 and 20.3% Play@3.",
          "With Claude-Sonnet-4, PlayCoder reaches 36.8% Exec@3 and 20.3% Play@3, demonstrating model-agnostic benefits.",
          { title: "PlayCoder: Making LLM-Generated GUI Code Playable" },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
  });

  it("supports MIA Reflect-Replan details without requiring MIA Planner adjacency", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "MIA Planner triggers Reflect Replan mechanism after Executor feedback",
      candidateFeedItemIds: [5031],
      hits: [
        makeHit(
          1,
          5031,
          "The Executor reports status to the Planner; the Planner triggers Reflect-Replan after feedback.",
          "Section: MIA Agent Loop. The Executor reports execution status to the Planner after obtaining the final answer. The Planner triggers Reflect-Replan mechanism to dynamically adjust the search.",
          {
            title: "Memory Intelligence Agent",
            entity_labels: ["MIA", "Planner", "Executor"],
          },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
    expect(verification.chunks[0].identityAnchorMatches.candidate).toContain(
      "mia",
    );
  });

  it("demotes evidence when a requested paper identity only appears inside another paper chunk", () => {
    const verification = verifyPaperEvidenceChunks({
      query:
        "What did the Mamba state space model paper show about selective scan for long-context modeling?",
      candidateFeedItemIds: [5515],
      hits: [
        makeHit(
          1,
          5515,
          "Sessa compares against Mamba and studies selective scan for long-context modeling.",
          "Sessa: Selective State Space Attention compares against Mamba and improves selective scan for long-context modeling.",
          {
            title: "Sessa: Selective State Space Attention",
            entity_labels: ["Mamba", "selective scan", "long context"],
          },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("paper_related_only");
    expect(verification.metadata.supporting_chunk_ids).toEqual([]);
    expect(verification.chunks[0].identityAnchorMatches.chunk).toContain(
      "mamba",
    );
    expect(verification.chunks[0].identityAnchorMatches.candidate).toEqual([]);
    expect(verification.chunks[0].demotionReason).toBe(
      "missing candidate paper identity",
    );
  });

  it("matches acronym anchors attached to numeric notation", () => {
    const verification = verifyPaperEvidenceChunks({
      query:
        "A^2TGPO: Agentic Turn-Group Policy Optimization with Adaptive Turn-level Clipping",
      candidateFeedItemIds: [5730],
      hits: [
        makeHit(
          1,
          5730,
          "The paper proposes A^2TGPO (Agentic Turn-Group Policy Optimization with Adaptive Turn-level Clipping).",
          "In this paper, we propose A^2TGPO (Agentic Turn-Group Policy Optimization with Adaptive Turn-level Clipping), which retains IG as the intrinsic signal.",
          {
            title:
              "A^2TGPO: Agentic Turn-Group Policy Optimization with Adaptive Turn-level Clipping",
          },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
    expect(verification.metadata.supporting_chunk_ids).toEqual([1]);
  });

  it("supports PlayCoder Flappy Bird evidence without cross-field adjacency", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "PlayCoder Flappy Bird compiles but bird passes through obstacles",
      candidateFeedItemIds: [5425],
      hits: [
        makeHit(
          1,
          5425,
          "A Flappy Bird game compiles and runs, but allows the bird to pass through obstacles.",
          "Figure 1 illustrates a Flappy Bird game. The program compiles and runs, but it allows the bird to pass through obstacles.",
          { title: "PlayCoder: Making LLM-Generated GUI Code Playable" },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
  });

  it("supports PlayCoder category table evidence without a long composite anchor", () => {
    const verification = verifyPaperEvidenceChunks({
      query:
        "PlayEval has Game Emulation Classic Games Game Engine Standalone Applications Desktop Widgets MMORPG Games",
      candidateFeedItemIds: [5425],
      hits: [
        makeHit(
          1,
          5425,
          "PlayEval categories include Game Emulation, Classic Games, Game Engine, Standalone Applications, Desktop Widgets, and MMORPG Games.",
          "Table 1 lists the PlayEval categories: Game Emulation, Classic Games, Game Engine, Standalone Applications, Desktop Widgets, and MMORPG Games.",
          { title: "PlayCoder: Making LLM-Generated GUI Code Playable" },
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
  });

  it("allows conceptual paraphrase support without exact label wording", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "How does the paper describe reflection feedback loops?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(
          1,
          10,
          "The method uses feedback for reflection across repeated attempts.",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
    expect(verification.metadata.supporting_chunk_ids).toEqual([1]);
  });

  it("requires exact numeric support for detail-sensitive claims", () => {
    const verification = verifyPaperEvidenceChunks({
      query:
        "Which paper reports Tree of Thoughts 74.0% score on Game-of-24?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(
          1,
          10,
          "Tree of Thoughts improves the score on Game-of-24 without the requested number.",
          "Tree of Thoughts improves the score on Game-of-24.",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("paper_related_only");
  });

  it("does not allow reference chunks to support substantive claims", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "Which paper introduced GEMS domain skills?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(
          1,
          10,
          "Section: References\n[1] GEMS: Generalizable Embodied Manipulation Skills. arXiv, 2025.\n[2] Domain skills for robots. doi:10.1000/example, 2024.\n[3] Other work. arXiv, 2023.",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("weak/reference_evidence");
    expect(verification.metadata.weak_reference_chunk_ids).toEqual([1]);
    expect(verification.metadata.supporting_chunk_ids).toEqual([]);
  });

  it("allows reference chunks for explicit citation questions", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "What papers does this paper cite about GEMS domain skills?",
      candidateFeedItemIds: [10],
      hits: [
        makeHit(
          1,
          10,
          "Section: References\n[1] GEMS: Generalizable Embodied Manipulation Skills. arXiv, 2025.\n[2] Domain skills for robots. doi:10.1000/example, 2024.\n[3] Other work. arXiv, 2023.",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("supports");
    expect(verification.chunks[0].isReferenceLike).toBe(true);
  });

  it("does not let a paper card support method or result claims", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "What result score did Claw-Eval-Live report for live workflows?",
      candidateFeedItemIds: [1831],
      hits: [
        makeHit(
          1,
          1831,
          "Paper card: Title: Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
        ),
      ],
    });

    expect(verification.metadata.status).toBe("paper_related_only");
    expect(verification.chunks[0].reason).toContain("paper card");
  });

  it("marks empty candidate discovery as unsupported", () => {
    const verification = verifyPaperEvidenceChunks({
      query: "clinical dosage guideline for agent benchmark medication",
      candidateFeedItemIds: [],
      hits: [],
    });

    expect(verification.metadata.status).toBe("unsupported");
  });
});
