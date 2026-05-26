// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Digest } from "@/lib/schema";

import { ChatPanel } from "../deep-dive/chat-panel";

const SAMPLE_DIGEST: Digest = {
  id: 1,
  content: "# AI Builders Digest\n\nSample content",
  item_count: 5,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 1,
  paper_count: 0,
  source_item_ids: [1, 2, 3],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T08:00:00Z",
};

function mockFetchStream(text: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const word of text.split(" ")) {
        controller.enqueue(encoder.encode(word + " "));
      }
      controller.close();
    },
  });

  return vi.fn().mockResolvedValueOnce({
    ok: true,
    body: stream,
  });
}

function mockFetchError(message = "Server error") {
  return vi.fn().mockResolvedValueOnce({
    ok: false,
    json: () => Promise.resolve({ error: message }),
  });
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows welcome message initially", () => {
    render(<ChatPanel digest={SAMPLE_DIGEST} />);
    expect(
      screen.getByText(/ask.*about this digest/i),
    ).toBeInTheDocument();
  });

  it("displays user message after sending", async () => {
    const fetchMock = mockFetchStream("Great question!");
    global.fetch = fetchMock;

    const user = userEvent.setup();
    render(<ChatPanel digest={SAMPLE_DIGEST} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Tell me about the tweets{Enter}");

    expect(
      screen.getByText("Tell me about the tweets"),
    ).toBeInTheDocument();
  });

  it("calls /api/deep-dive with correct payload", async () => {
    const fetchMock = mockFetchStream("Response text.");
    global.fetch = fetchMock;

    const user = userEvent.setup();
    render(<ChatPanel digest={SAMPLE_DIGEST} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "What happened?{Enter}");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/deep-dive",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining('"digestId":1'),
        }),
      );
    });

    // Verify messages are included
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.messages).toEqual([
      { role: "user", content: "What happened?" },
    ]);
  });

  it("displays streamed assistant response", async () => {
    const fetchMock = mockFetchStream("The tweets discussed AI breakthroughs.");
    global.fetch = fetchMock;

    const user = userEvent.setup();
    render(<ChatPanel digest={SAMPLE_DIGEST} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Tell me more{Enter}");

    await waitFor(() => {
      expect(
        screen.getByText(/AI breakthroughs/),
      ).toBeInTheDocument();
    });
  });

  it("handles API errors gracefully", async () => {
    const fetchMock = mockFetchError("Something went wrong");
    global.fetch = fetchMock;

    const user = userEvent.setup();
    render(<ChatPanel digest={SAMPLE_DIGEST} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Hello{Enter}");

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });

  // -- Edge cases -----------------------------------------------------------

  it("shows error message when fetch throws a network error", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const user = userEvent.setup();
    render(<ChatPanel digest={SAMPLE_DIGEST} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Hello{Enter}");

    await waitFor(() => {
      expect(screen.getByText(/failed to fetch/i)).toBeInTheDocument();
    });
  });

  it("shows partial text and error when stream fails mid-response", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("Partial response"));
        // Error on next read via a queued microtask
        Promise.resolve().then(() => {
          controller.error(new Error("Stream interrupted"));
        });
      },
    });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: stream,
    });

    const user = userEvent.setup();
    render(<ChatPanel digest={SAMPLE_DIGEST} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Hello{Enter}");

    await waitFor(() => {
      expect(screen.getByText(/stream interrupted/i)).toBeInTheDocument();
    });

    // isStreaming should reset — textarea should be enabled again
    const textarea2 = screen.getByPlaceholderText(/ask/i);
    expect(textarea2).not.toBeDisabled();
  });

  it("renders without crash when digest content is empty", () => {
    const emptyDigest = { ...SAMPLE_DIGEST, content: "" };
    render(<ChatPanel digest={emptyDigest} />);

    expect(screen.getByText(/ask.*about this digest/i)).toBeInTheDocument();
  });
});
