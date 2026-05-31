// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Digest } from "@/lib/schema";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock server actions
vi.mock("@/app/actions", () => ({
  generateDigestAction: vi.fn(),
}));

// Mock the briefing hook (so the lazy-loaded overlay doesn't hit real code)
vi.mock("@/hooks/use-briefing-session", () => ({
  useBriefingSession: () => ({
    status: "idle",
    transcriptItems: [],
    isAiSpeaking: false,
    isUserSpeaking: false,
    isMuted: false,
    elapsedSeconds: 0,
    error: null,
    briefingSessionId: null,
    canSendText: false,
    start: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    stopCurrentResponse: vi.fn(),
    clearError: vi.fn(),
  }),
}));

import { DashboardDigest } from "../dashboard-digest";

const DIGEST: Digest = {
  id: 1,
  content: "# Digest\n\nContent here.",
  item_count: 5,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 1,
  paper_count: 0,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T10:00:00Z",
};

describe("DashboardDigest — briefing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Start Briefing", () => {
    render(<DashboardDigest digest={DIGEST} />);
    expect(screen.getByTestId("start-briefing-button")).toBeInTheDocument();
    expect(screen.getByText("Start Briefing")).toBeInTheDocument();
  });

  it("opens briefing overlay when Start Briefing is clicked", async () => {
    const user = userEvent.setup();
    render(<DashboardDigest digest={DIGEST} />);
    await user.click(screen.getByTestId("start-briefing-button"));
    await waitFor(() => {
      expect(document.querySelector("[data-testid='briefing-overlay']")).toBeInTheDocument();
    });
  });

});
