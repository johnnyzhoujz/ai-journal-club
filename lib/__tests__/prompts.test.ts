import { describe, expect, it } from "vitest";
import { BRIEFING, DIGEST_INTRO, SUMMARIZE_PAPERS } from "../prompts";

describe("journal-club prompt contracts", () => {
  it("tells the paper summarizer to produce journal-club picks and quick scan papers", () => {
    expect(SUMMARIZE_PAPERS).toContain("Journal Club Picks");
    expect(SUMMARIZE_PAPERS).toContain("Quick Scan");
    expect(SUMMARIZE_PAPERS).toContain("top 5-10 papers");
    expect(SUMMARIZE_PAPERS).toContain("8-12 minute");
    expect(SUMMARIZE_PAPERS).toContain("1,300-2,000 spoken words");
    expect(SUMMARIZE_PAPERS).toContain("150-250 words");
    expect(SUMMARIZE_PAPERS).toContain("8-12 concise");
    expect(SUMMARIZE_PAPERS).toContain("Mention the paper title explicitly");
    expect(SUMMARIZE_PAPERS).toContain("Define technical terms in plain language");
    expect(SUMMARIZE_PAPERS).toContain("paper_evidence_cards");
    expect(SUMMARIZE_PAPERS).toContain("Light on");
    expect(SUMMARIZE_PAPERS).toContain("detail");
    expect(SUMMARIZE_PAPERS).toContain("Write for audio first");
  });

  it("tells the final digest prompt to format papers as two tiers", () => {
    expect(DIGEST_INTRO).toContain("Research Papers` into");
    expect(DIGEST_INTRO).toContain("### Journal Club Picks");
    expect(DIGEST_INTRO).toContain("### Quick Scan");
    expect(DIGEST_INTRO).toContain("5-10 papers");
    expect(DIGEST_INTRO).toContain("8-12 minute");
    expect(DIGEST_INTRO).toContain("1,300-2,000 spoken words");
    expect(DIGEST_INTRO).toContain("150-250 words");
    expect(DIGEST_INTRO).toContain("8-12 concise");
    expect(DIGEST_INTRO).toContain("Use Quick Scan for lower-priority papers");
  });

  it("tells the realtime briefing to present and deepen the saved digest format", () => {
    expect(BRIEFING).toContain("Use the saved CURRENT DIGEST as the evidence base");
    expect(BRIEFING).toContain("do not read it word-for-word");
    expect(BRIEFING).toContain("Use one short analogy when it clarifies");
    expect(BRIEFING).toContain("3–5 minutes");
    expect(BRIEFING).toContain("Journal Club Picks");
    expect(BRIEFING).toContain("Quick Scan");
    expect(BRIEFING).toContain("source-specific evidence retrieval tools");
    expect(BRIEFING).toContain("continue from the current paper");
    expect(BRIEFING).toContain("named paper");
  });
});
