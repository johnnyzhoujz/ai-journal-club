import { readFileSync } from "fs";
import { join } from "path";

const promptsDir = join(process.cwd(), "prompts");

function loadPrompt(filename: string): string {
  return readFileSync(join(promptsDir, filename), "utf-8");
}

export const DIGEST_INTRO = loadPrompt("digest-intro.md");
export const SUMMARIZE_TWEETS = loadPrompt("summarize-tweets.md");
export const SUMMARIZE_PODCAST = loadPrompt("summarize-podcast.md");
export const SUMMARIZE_NEWSLETTER = loadPrompt("summarize-newsletter.md");
export const SUMMARIZE_PAPERS = loadPrompt("summarize-papers.md");
export const TRANSLATE = loadPrompt("translate.md");
export const RESEARCH_ANSWER = loadPrompt("research-answer.md");
export const DEEP_DIVE = loadPrompt("deep-dive.md");
export const BRIEFING = loadPrompt("briefing.md");
export const BRIEFING_MEMORY = loadPrompt("briefing-memory.md");
