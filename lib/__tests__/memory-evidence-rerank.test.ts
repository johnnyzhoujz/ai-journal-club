import { describe, expect, it } from "vitest";

import {
  buildEvidenceClaimProfile,
  rerankEvidenceChunksForClaim,
  scoreEvidenceChunkForClaim,
} from "@/lib/memory-evidence-rerank";
import type { MemorySearchChunkHit } from "@/lib/schema";

function makeHit(
  id: number,
  feedItemId: number,
  snippet: string,
): MemorySearchChunkHit {
  return {
    kind: "chunk",
    id,
    feed_item_id: feedItemId,
    source_type: "paper",
    title: "Paper",
    author_name: "Research Team",
    published_at: null,
    url: "https://example.com/paper",
    text: snippet,
    snippet,
    entity_labels: [],
  };
}

describe("memory evidence rerank", () => {
  it("matches numeric percent variants", () => {
    const profile = buildEvidenceClaimProfile(
      "Claw-Eval-Live leading model passes only 20.3 percent of tasks",
      ["20.3 percent of tasks"],
    );
    const score = scoreEvidenceChunkForClaim(
      profile,
      "The strongest model passes 20.3% of workflow tasks.",
    );

    expect(score.matchedNumbers).toContain("20.3 percent");
    expect(score.score).toBeGreaterThan(0);
  });

  it("matches symbol variants for Play@3", () => {
    const profile = buildEvidenceClaimProfile("Play@3 benchmark", ["Play@3"]);

    expect(
      scoreEvidenceChunkForClaim(profile, "The paper reports Play 3 results.")
        .matchedHyphenatedTerms,
    ).toContain("Play@3");
    expect(
      scoreEvidenceChunkForClaim(profile, "The paper reports Play-3 results.")
        .matchedHyphenatedTerms,
    ).toContain("Play@3");
  });

  it("matches acronym and title overlap", () => {
    const profile = buildEvidenceClaimProfile(
      "MIA Memory Intelligence Agent historical experiences",
      ["MIA", "Memory Intelligence Agent"],
    );
    const score = scoreEvidenceChunkForClaim(
      profile,
      "Memory Intelligence Agent (MIA) stores historical experiences.",
    );

    expect(score.matchedAcronyms).toContain("MIA");
    expect(score.matchedEntities).toContain("Memory Intelligence Agent");
  });

  it("matches hyphenated benchmark terms", () => {
    const profile = buildEvidenceClaimProfile(
      "Game-of-24 and SWE-bench Verified",
      ["Game-of-24", "SWE-bench Verified"],
    );
    const score = scoreEvidenceChunkForClaim(
      profile,
      "The method improves Game of 24 and SWE bench Verified scores.",
    );

    expect(score.matchedHyphenatedTerms).toEqual(
      expect.arrayContaining(["Game-of-24", "SWE-bench"]),
    );
  });

  it("penalizes generic-only matches below specific evidence", () => {
    const profile = buildEvidenceClaimProfile(
      "Tree of Thoughts reports 74.0% on Game-of-24",
      ["Tree of Thoughts", "74.0% on Game-of-24"],
    );
    const generic = scoreEvidenceChunkForClaim(
      profile,
      "This paper introduces an agent benchmark framework.",
    );
    const specific = scoreEvidenceChunkForClaim(
      profile,
      "Tree of Thoughts reaches 74.0% on Game-of-24.",
    );

    expect(generic.penaltyCount).toBeGreaterThan(0);
    expect(specific.score).toBeGreaterThan(generic.score);
  });

  it("reranks chunks within candidate paper order by content evidence score", () => {
    const reranked = rerankEvidenceChunksForClaim({
      query: "Which agent paper reports 74.0% on Game-of-24 with Tree of Thoughts?",
      claimEvidenceQueries: ["Tree of Thoughts", "74.0% on Game-of-24"],
      candidateFeedItemIds: [10],
      hits: [
        makeHit(1, 10, "A generic agent benchmark paper abstract."),
        makeHit(2, 10, "Tree of Thoughts reaches 74.0% on Game-of-24."),
      ],
    });

    expect(reranked.map((hit) => hit.id)).toEqual([2, 1]);
    expect(reranked[0].contentEvidenceScore.matchedNumbers).toContain("74.0%");
  });

  it("keeps candidate paper order ahead of cross-paper score", () => {
    const reranked = rerankEvidenceChunksForClaim({
      query: "Tree of Thoughts reports 74.0% on Game-of-24",
      claimEvidenceQueries: ["Tree of Thoughts", "74.0% on Game-of-24"],
      candidateFeedItemIds: [10, 11],
      hits: [
        makeHit(1, 10, "A generic agent benchmark paper abstract."),
        makeHit(2, 11, "Tree of Thoughts reaches 74.0% on Game-of-24."),
      ],
    });

    expect(reranked.map((hit) => hit.feed_item_id)).toEqual([10, 11]);
  });
});
