import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

const mockStream = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: mockStream },
  })),
}));

vi.mock("@/lib/prompts", () => ({
  DEEP_DIVE: "DEEP_DIVE_PROMPT",
}));

vi.mock("@/lib/deep-dive", () => ({
  getDigestSourceItems: vi.fn(),
}));

import { POST } from "../route";
import { sql } from "@/lib/db";
import { getDigestSourceItems } from "@/lib/deep-dive";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockGetDigestSourceItems = getDigestSourceItems as ReturnType<typeof vi.fn>;

const SAMPLE_DIGEST = {
  id: 1,
  content: "# AI Builders Digest\n\nSample content",
  item_count: 5,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 1,
  paper_count: 0,
  source_item_ids: [10, 20, 30, 40, 50],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T08:00:00Z",
};

const SAMPLE_SOURCE_ITEMS = [
  {
    id: 10,
    source_type: "tweet",
    content: "AI is changing everything",
    author_name: "karpathy",
    url: "https://x.com/karpathy/status/123",
  },
];

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost:3000/api/deep-dive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function mockStreamResponse(text = "Here is a deep dive response.") {
  const chunks = text.split(" ").map((word, i) => (i > 0 ? " " + word : word));
  mockStream.mockReturnValueOnce({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: chunk },
        };
      }
    },
  });
}

describe("POST /api/deep-dive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    mockGetDigestSourceItems.mockResolvedValue(SAMPLE_SOURCE_ITEMS);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // -- Validation tests -------------------------------------------------------

  it("returns 400 when body is missing", async () => {
    const req = new Request("http://localhost:3000/api/deep-dive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when digestId is missing", async () => {
    const res = await POST(
      makeRequest({ messages: [{ role: "user", content: "hello" }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when messages is empty", async () => {
    const res = await POST(makeRequest({ digestId: 1, messages: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when messages is missing", async () => {
    const res = await POST(makeRequest({ digestId: 1 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when last message is not from user", async () => {
    const res = await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "assistant", content: "I am the assistant" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  // -- Digest lookup ----------------------------------------------------------

  it("returns 404 when digest not found", async () => {
    mockSql.mockResolvedValueOnce([]); // empty result

    const res = await POST(
      makeRequest({
        digestId: 999,
        messages: [{ role: "user", content: "tell me more" }],
      }),
    );
    expect(res.status).toBe(404);
  });

  // -- Happy path -------------------------------------------------------------

  it("returns streaming response for valid request", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse("Hello from deep dive");

    const res = await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "tell me more" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    // Read the full stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
    }
    expect(fullText).toContain("Hello");
    expect(fullText).toContain("deep");
    expect(fullText).toContain("dive");
  });

  // -- System prompt construction ---------------------------------------------

  it("includes digest content in system prompt", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse();

    await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "tell me more" }],
      }),
    );

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.system).toContain("DEEP_DIVE_PROMPT");
    expect(callArgs.system).toContain("AI Builders Digest");
    expect(callArgs.system).toContain("Sample content");
  });

  it("includes source items in system prompt", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse();

    await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "tell me more" }],
      }),
    );

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.system).toContain("karpathy");
    expect(callArgs.system).toContain("AI is changing everything");
  });

  it("passes conversation history to Claude", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse();

    const messages = [
      { role: "user", content: "What about the tweets?" },
      { role: "assistant", content: "The tweets covered AI topics." },
      { role: "user", content: "Tell me more about karpathy" },
    ];

    await POST(makeRequest({ digestId: 1, messages }));

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[0].content).toBe("What about the tweets?");
    expect(callArgs.messages[2].content).toBe("Tell me more about karpathy");
  });

  it("uses Sonnet 4.6 model", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse();

    await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-sonnet-4-6");
  });

  it("passes source_item_ids and generated_at to getDigestSourceItems", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse();

    await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(mockGetDigestSourceItems).toHaveBeenCalledWith(
      [10, 20, 30, 40, 50],
      "2026-03-21T08:00:00Z",
    );
  });

  // -- Error handling ---------------------------------------------------------

  it("returns 500 when stream fails", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStream.mockImplementationOnce(() => {
      throw new Error("API error");
    });

    const res = await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // -- Edge cases -------------------------------------------------------------

  it("returns 400 when digestId is a string", async () => {
    const res = await POST(
      makeRequest({
        digestId: "abc",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/digestId/i);
  });

  it("returns 400 when digestId is null", async () => {
    const res = await POST(
      makeRequest({
        digestId: null,
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("passes large conversation history (50+ messages) to Claude", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockStreamResponse();

    const messages = Array.from({ length: 51 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));
    // Ensure last message is from user
    messages.push({ role: "user", content: "Final question" });

    await POST(makeRequest({ digestId: 1, messages }));

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(52);
    expect(callArgs.messages[51].content).toBe("Final question");
  });

  it("returns 500 when getDigestSourceItems throws", async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_DIGEST]);
    mockGetDigestSourceItems.mockRejectedValueOnce(
      new Error("Database connection failed"),
    );

    const res = await POST(
      makeRequest({
        digestId: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Database connection failed");
  });
});
