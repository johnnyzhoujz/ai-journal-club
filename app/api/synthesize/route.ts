// TODO: add authentication
import Anthropic from "@anthropic-ai/sdk";
import { RESEARCH_ANSWER } from "@/lib/prompts";

export async function POST(request: Request) {
  let body: { query?: string; results?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { query, results } = body;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return Response.json({ error: "Missing or empty query" }, { status: 400 });
  }

  if (!results || !Array.isArray(results) || results.length === 0) {
    return Response.json({ error: "Missing or empty results" }, { status: 400 });
  }

  try {
    const anthropic = new Anthropic();

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: RESEARCH_ANSWER,
      messages: [
        {
          role: "user",
          content: JSON.stringify({ query, results }),
        },
      ],
    });

    const synthesis = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return Response.json({ synthesis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Synthesis failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
