import Anthropic from "@anthropic-ai/sdk";
import { sql } from "@/lib/db";
import { DEEP_DIVE } from "@/lib/prompts";
import { getDigestSourceItems } from "@/lib/deep-dive";
import type { Digest } from "@/lib/schema";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request) {
  let body: { digestId?: number; messages?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { digestId, messages } = body;

  if (digestId === undefined || typeof digestId !== "number") {
    return Response.json(
      { error: "Missing or invalid digestId" },
      { status: 400 },
    );
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "Missing or empty messages" },
      { status: 400 },
    );
  }

  if (messages[messages.length - 1].role !== "user") {
    return Response.json(
      { error: "Last message must be from user" },
      { status: 400 },
    );
  }

  // Fetch digest
  const digests = (await sql`
    SELECT * FROM digests WHERE id = ${digestId}
  `) as Digest[];

  if (digests.length === 0) {
    return Response.json({ error: "Digest not found" }, { status: 404 });
  }

  const digest = digests[0];

  try {
    // Fetch full source items — no truncation, Sonnet 4.6 has 1M context
    const sourceItems = await getDigestSourceItems(
      digest.source_item_ids,
      digest.generated_at,
    );

    // Build system prompt with full source content
    const systemPrompt = [
      DEEP_DIVE,
      "\n\n## Digest\n\n",
      digest.content,
      "\n\n## Source Items\n\n",
      JSON.stringify(sourceItems),
    ].join("");

    // Stream response using Sonnet 4.6 with 1M context
    const anthropic = new Anthropic();
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deep dive failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
