import { describe, expect, it } from "vitest";
import { BRIEFING, DIGEST_INTRO, SUMMARIZE_PAPERS } from "../prompts";

describe("journal-club prompt contracts", () => {
  it("tells the paper summarizer to produce journal-club picks and quick scan papers", () => {
    expect(SUMMARIZE_PAPERS).toContain("Journal Club Picks");
    expect(SUMMARIZE_PAPERS).toContain("Quick Scan");
    expect(SUMMARIZE_PAPERS).toContain("top 3-5 papers");
    expect(SUMMARIZE_PAPERS).toContain("Never put more than 5 papers");
    expect(SUMMARIZE_PAPERS).toContain("8-12 minute");
    expect(SUMMARIZE_PAPERS).toContain("1,100-1,700 spoken words");
    expect(SUMMARIZE_PAPERS).toContain("200-300 words");
    expect(SUMMARIZE_PAPERS).toContain("10-14 concise");
    expect(SUMMARIZE_PAPERS).toContain("not a roll call");
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
    expect(DIGEST_INTRO).toContain("3-5 papers");
    expect(DIGEST_INTRO).toContain("Never put more than 5 papers");
    expect(DIGEST_INTRO).toContain("8-12 minute");
    expect(DIGEST_INTRO).toContain("1,100-1,700 spoken words");
    expect(DIGEST_INTRO).toContain("200-300 words");
    expect(DIGEST_INTRO).toContain("10-14 concise");
    expect(DIGEST_INTRO).toContain("Use Quick Scan for lower-priority papers");
    expect(DIGEST_INTRO).toContain("not a roll call");
  });

  it("tells the realtime briefing to present and deepen the saved digest format", () => {
    expect(BRIEFING).toContain("Use the saved CURRENT DIGEST as the evidence base");
    expect(BRIEFING).toContain("do not read it word-for-word");
    expect(BRIEFING).toContain("Use one short analogy when it clarifies");
    expect(BRIEFING).toContain("3–5 minutes");
    expect(BRIEFING).toContain("strongest 3–5");
    expect(BRIEFING).toContain("Do not read every pick");
    expect(BRIEFING).toContain("Journal Club Picks");
    expect(BRIEFING).toContain("Quick Scan");
    expect(BRIEFING).toContain("Never go through Quick Scan one by one");
    expect(BRIEFING).toContain("source-specific evidence retrieval tools");
    expect(BRIEFING).toContain("continue from the current paper");
    expect(BRIEFING).toContain("named paper");
  });
});
