// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseBriefingSessionResult } from "@/hooks/use-briefing-session";

// -- Mock useBriefingSession --------------------------------------------------

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockEnd = vi.fn().mockResolvedValue(undefined);
const mockToggleMute = vi.fn();
const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockStopCurrentResponse = vi.fn();
const mockClearError = vi.fn();

const defaultSession: UseBriefingSessionResult = {
  status: "idle",
  transcriptItems: [],
  isAiSpeaking: false,
  isUserSpeaking: false,
  isMuted: false,
  elapsedSeconds: 0,
  error: null,
  briefingSessionId: null,
  canSendText: false,
  remoteStream: null,
  start: mockStart,
  end: mockEnd,
  toggleMute: mockToggleMute,
  sendText: mockSendText,
  stopCurrentResponse: mockStopCurrentResponse,
  clearError: mockClearError,
};

let sessionOverrides: Partial<UseBriefingSessionResult> = {};

vi.mock("@/hooks/use-briefing-session", () => ({
  useBriefingSession: () => ({ ...defaultSession, ...sessionOverrides }),
}));

import { BriefingOverlay } from "../briefing/briefing-overlay";

const defaultProps = {
  digestId: 42,
  onClose: vi.fn(),
  onStaleDigest: vi.fn(),
  onSwitchToDeepDive: vi.fn(),
};

describe("BriefingOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionOverrides = {};
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  // -- Open / close -----------------------------------------------------------

  it("renders the overlay", () => {
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-overlay")).toBeInTheDocument();
  });

  it("auto-starts the briefing session on mount", () => {
    render(<BriefingOverlay {...defaultProps} />);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll on mount", () => {
    render(<BriefingOverlay {...defaultProps} />);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("restores body scroll on unmount", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(<BriefingOverlay {...defaultProps} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    render(<BriefingOverlay {...defaultProps} />);
    await user.click(screen.getByTestId("briefing-close-button"));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<BriefingOverlay {...defaultProps} />);
    const backdrop = document.querySelector("[data-testid='briefing-backdrop']")!;
    await user.click(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<BriefingOverlay {...defaultProps} />);
    await user.keyboard("{Escape}");
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  // -- Mic denied state -------------------------------------------------------

  it("shows error when microphone is denied", () => {
    sessionOverrides = {
      status: "error",
      error: { code: "microphone_denied", message: "Microphone access was denied" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-error")).toBeInTheDocument();
    expect(screen.getByText("Microphone access was denied")).toBeInTheDocument();
  });

  // -- Connection failure state ------------------------------------------------

  it("shows error and retry button on connection failure", () => {
    sessionOverrides = {
      status: "error",
      error: { code: "connection_failed", message: "Failed to connect" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-error")).toBeInTheDocument();
    expect(screen.getByTestId("briefing-retry-button")).toBeInTheDocument();
  });

  // -- Stale-digest state -----------------------------------------------------

  it("calls onStaleDigest when stale_digest error occurs", () => {
    sessionOverrides = {
      status: "error",
      error: { code: "stale_digest", message: "A newer digest is available" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(defaultProps.onStaleDigest).toHaveBeenCalledTimes(1);
  });

  it("does not show retry button for stale_digest error", () => {
    sessionOverrides = {
      status: "error",
      error: { code: "stale_digest", message: "A newer digest is available" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.queryByTestId("briefing-retry-button")).not.toBeInTheDocument();
  });

  // -- Startup playback failure -----------------------------------------------

  it("shows retry messaging on audio playback failure", () => {
    sessionOverrides = {
      status: "error",
      error: { code: "audio_playback_failed", message: "Could not start audio playback" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-retry-button")).toBeInTheDocument();
    expect(screen.getByText("Could not start audio playback")).toBeInTheDocument();
  });

  // -- Compact voice controls -------------------------------------------------

  it("does not render typed fallback controls in compact voice mode", () => {
    sessionOverrides = {
      status: "active",
      canSendText: true,
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("grid-visualizer")).toBeInTheDocument();
    expect(screen.queryByTestId("briefing-text-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("briefing-send-button")).not.toBeInTheDocument();
  });

  it("keeps typed fallback controls hidden when canSendText is false", () => {
    sessionOverrides = {
      status: "active",
      canSendText: false,
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.queryByTestId("briefing-text-input")).not.toBeInTheDocument();
  });

  // -- Switch to text Deep Dive -----------------------------------------------

  it("shows switch-to-deep-dive button on error", () => {
    sessionOverrides = {
      status: "error",
      error: { code: "connection_failed", message: "Failed to connect" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-switch-deep-dive")).toBeInTheDocument();
  });

  it("calls onSwitchToDeepDive and ends session", async () => {
    const user = userEvent.setup();
    sessionOverrides = {
      status: "error",
      error: { code: "connection_failed", message: "Failed to connect" },
    };
    render(<BriefingOverlay {...defaultProps} />);
    await user.click(screen.getByTestId("briefing-switch-deep-dive"));
    expect(mockEnd).toHaveBeenCalled();
    expect(defaultProps.onSwitchToDeepDive).toHaveBeenCalledTimes(1);
  });

  // -- Timer and mute controls ------------------------------------------------

  it("shows timer when active", () => {
    sessionOverrides = {
      status: "active",
      elapsedSeconds: 125,
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-timer")).toHaveTextContent("2:05");
  });

  it("shows mute button when active", () => {
    sessionOverrides = {
      status: "active",
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-mute-button")).toBeInTheDocument();
  });

  it("toggles mute when mute button is clicked", async () => {
    const user = userEvent.setup();
    sessionOverrides = {
      status: "active",
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    await user.click(screen.getByTestId("briefing-mute-button"));
    expect(mockToggleMute).toHaveBeenCalledTimes(1);
  });

  // -- Disconnected state with Start Again ------------------------------------

  it("shows Start Again when session has ended", () => {
    sessionOverrides = {
      status: "ended",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-start-again")).toBeInTheDocument();
  });

  it("calls start when Start Again is clicked", async () => {
    const user = userEvent.setup();
    sessionOverrides = {
      status: "ended",
    };
    render(<BriefingOverlay {...defaultProps} />);
    await user.click(screen.getByTestId("briefing-start-again"));
    expect(mockClearError).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  // -- End button -------------------------------------------------------------

  it("shows end button when active", () => {
    sessionOverrides = {
      status: "active",
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-end-button")).toBeInTheDocument();
  });

  it("ends session and closes on end button click", async () => {
    const user = userEvent.setup();
    sessionOverrides = {
      status: "active",
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    await user.click(screen.getByTestId("briefing-end-button"));
    expect(mockEnd).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  // -- Stop speaking button ---------------------------------------------------

  it("shows stop button when AI is speaking", () => {
    sessionOverrides = {
      status: "active",
      isAiSpeaking: true,
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.getByTestId("briefing-stop-button")).toBeInTheDocument();
  });

  it("does not show stop button when AI is not speaking", () => {
    sessionOverrides = {
      status: "active",
      isAiSpeaking: false,
      briefingSessionId: "sess-1",
    };
    render(<BriefingOverlay {...defaultProps} />);
    expect(screen.queryByTestId("briefing-stop-button")).not.toBeInTheDocument();
  });
});
