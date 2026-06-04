import { describe, expect, it } from "vitest";
import {
  BRIEFING,
  DIGEST_INTRO,
  RESEARCH_ANSWER,
  SUMMARIZE_NEWSLETTER,
  SUMMARIZE_PAPERS,
  SUMMARIZE_PODCAST,
  SUMMARIZE_TWEETS,
} from "../prompts";

describe("journal-club prompt contracts", () => {
  it("tells the paper summarizer to produce journal-club picks and quick scan papers", () => {
    expect(SUMMARIZE_PAPERS).toContain("Journal Club Picks");
    expect(SUMMARIZE_PAPERS).toContain("Quick Scan");
    expect(SUMMARIZE_PAPERS).toContain("top 3-7 papers");
    expect(SUMMARIZE_PAPERS).toContain("10-15 minute");
    expect(SUMMARIZE_PAPERS).toContain("2,000-3,200 spoken words");
    expect(SUMMARIZE_PAPERS).toContain("250-400 words");
    expect(SUMMARIZE_PAPERS).toContain("12-18 concise");
    expect(SUMMARIZE_PAPERS).toContain("Mention the paper title explicitly");
    expect(SUMMARIZE_PAPERS).toContain("Define technical terms in plain language");
    expect(SUMMARIZE_PAPERS).toContain("paper_evidence_cards");
    expect(SUMMARIZE_PAPERS).toContain("users can skip verbally");
    expect(SUMMARIZE_PAPERS).toContain("Light on");
    expect(SUMMARIZE_PAPERS).toContain("detail");
    expect(SUMMARIZE_PAPERS).toContain("Write for audio first");
  });

  it("tells the final digest prompt to format papers as two tiers", () => {
    expect(DIGEST_INTRO).toContain("# AI Journal Club Digest");
    expect(DIGEST_INTRO.indexOf("## 📄 Research Papers")).toBeLessThan(
      DIGEST_INTRO.indexOf("## 🐦 X / Twitter"),
    );
    expect(DIGEST_INTRO).toContain("Research Papers` into");
    expect(DIGEST_INTRO).toContain("### Journal Club Picks");
    expect(DIGEST_INTRO).toContain("### Quick Scan");
    expect(DIGEST_INTRO).toContain("3-7 papers");
    expect(DIGEST_INTRO).toContain("10-15 minute");
    expect(DIGEST_INTRO).toContain("2,000-3,200 spoken words");
    expect(DIGEST_INTRO).toContain("250-400 words");
    expect(DIGEST_INTRO).toContain("12-18 concise");
    expect(DIGEST_INTRO).toContain("Use Quick Scan for lower-priority papers");
    expect(DIGEST_INTRO).toContain("research papers as the primary evidence base");
  });

  it("keeps paper answers source-grounded and paper-first", () => {
    expect(RESEARCH_ANSWER).toContain("research papers");
    expect(RESEARCH_ANSWER).toContain("supporting context");
    expect(RESEARCH_ANSWER).toContain("Prefer paper evidence");
    expect(RESEARCH_ANSWER).toContain("Do not use outside knowledge");
    expect(RESEARCH_ANSWER).toContain("unsupported inferences");
  });

  it("frames non-paper prompt inputs as supporting context", () => {
    expect(SUMMARIZE_TWEETS).toContain("supporting context");
    expect(SUMMARIZE_PODCAST).toContain("supporting context");
    expect(SUMMARIZE_NEWSLETTER).toContain("supporting context");
  });

  it("tells the realtime briefing to present and deepen the saved digest format", () => {
    expect(BRIEFING).toContain("Use the saved CURRENT DIGEST as the evidence base");
    expect(BRIEFING).toContain("do not read it word-for-word");
    expect(BRIEFING).toContain("Use one short analogy when it clarifies");
    expect(BRIEFING).toContain("5–8 minutes");
    expect(BRIEFING).toContain("skip, speed up, or summarize");
    expect(BRIEFING).toContain("Journal Club Picks");
    expect(BRIEFING).toContain("Quick Scan");
    expect(BRIEFING).toContain("source-specific evidence retrieval tools");
    expect(BRIEFING).toContain("continue from the current paper");
    expect(BRIEFING).toContain("named paper");
  });
});
