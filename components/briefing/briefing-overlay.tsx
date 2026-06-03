"use client";

import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { X, AlertTriangle, RefreshCw, Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBriefingSession } from "@/hooks/use-briefing-session";
import type { BriefingUiError, BriefingStatus } from "@/hooks/use-briefing-session";
import { useMultibandVolume } from "@/hooks/use-multiband-volume";
import type { GridVisualizerState } from "@/hooks/use-grid-visualizer";
import { GridVisualizer } from "./grid-visualizer";
import { TranscriptFeed } from "./transcript-feed";
import { BriefingStatusIndicator } from "./briefing-status-indicator";

const BRIEFING_TRANSCRIPT_ENABLED =
  process.env.NEXT_PUBLIC_BRIEFING_TRANSCRIPT_ENABLED === "true";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface BriefingOverlayProps {
  digestId: number;
  onClose: () => void;
  onStaleDigest: () => void;
}

function isRetryableError(error: BriefingUiError): boolean {
  if (!error) return false;
  const nonRetryable = ["stale_digest", "too_many_active_sessions"];
  return !nonRetryable.includes(error.code);
}

export function BriefingOverlay({
  digestId,
  onClose,
  onStaleDigest,
}: BriefingOverlayProps) {
  const session = useBriefingSession({ digestId });
  const volumeBands = useMultibandVolume(session.remoteStream, 5);

  // Volume above this threshold means audio is actively playing.
  // Low threshold (0.01) to avoid missing frames between words.
  const hasAudioVolume = volumeBands.some((v) => v > 0.01);

  const gridState = deriveGridState(
    session.status,
    session.isAiSpeaking,
    session.isUserSpeaking,
    hasAudioVolume,
  );

  // Auto-start on mount
  useEffect(() => {
    if (session.status === "idle") {
      session.start();
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle stale_digest: close overlay and trigger dashboard refresh
  useEffect(() => {
    if (session.error?.code === "stale_digest") {
      onStaleDigest();
    }
  }, [session.error?.code, onStaleDigest]);

  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.status],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  async function handleClose() {
    if (session.status === "active" || session.status === "connecting") {
      await session.end();
    }
    onClose();
  }

  async function handleRetry() {
    session.clearError();
    await session.start();
  }

  const showControls = session.status === "active" || session.status === "connecting";
  const showError = session.status === "error" && session.error;

  return createPortal(
    <>
      {/* Backdrop */}
      <motion.div
        data-testid="briefing-backdrop"
        className="fixed inset-0 z-50 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={handleClose}
      />

      {/* Content — wide, compact voice-assistant layout */}
      <motion.div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pointer-events-none"
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
      >
        <div
          className="relative w-full sm:w-[90vw] sm:max-w-[1100px] h-[50vh] sm:h-[420px] bg-background rounded-t-xl sm:rounded-xl border border-border shadow-2xl overflow-hidden pointer-events-auto flex flex-col"
          data-testid="briefing-overlay"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 shrink-0">
            <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
              {session.status === "connecting" && "Connecting"}
              {session.status === "active" && "Briefing"}
              {session.status === "error" && "Briefing Error"}
              {session.status === "ended" && "Briefing Ended"}
              {session.status === "idle" && "Starting"}
            </h2>
            <div className="flex items-center gap-3">
              {(showControls || session.status === "ended") && (
                <span
                  className="text-sm text-muted-foreground font-mono tabular-nums"
                  data-testid="briefing-timer"
                >
                  {formatTime(session.elapsedSeconds)}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleClose}
                aria-label="Close briefing"
                data-testid="briefing-close-button"
                className="rounded-full"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Center stage: native audio visualizer. */}
          {showControls && (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-10">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="text-primary"
              >
                <GridVisualizer state={gridState} volumeBands={volumeBands} size="xl" />
              </motion.div>
              <BriefingStatusIndicator state={gridState} />
            </div>
          )}

          {BRIEFING_TRANSCRIPT_ENABLED && (
            <TranscriptFeed
              items={session.transcriptItems}
              isAudioPlaying={session.isAiSpeaking || hasAudioVolume}
              className="max-h-44 border-t border-border"
            />
          )}

          {/* Error state */}
          {showError && session.error && (
            <div className="px-6 py-4 border-t border-border shrink-0" data-testid="briefing-error">
              <div className="flex items-start gap-3 text-sm">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-destructive font-medium">{session.error.message}</p>
                  <div className="flex gap-2 mt-3">
                    {isRetryableError(session.error) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRetry}
                        data-testid="briefing-retry-button"
                      >
                        <RefreshCw className="h-3.5 w-3.5 mr-1" />
                        Try Again
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Ended state */}
          {session.status === "ended" && (
            <div className="px-6 py-4 border-t border-border shrink-0" data-testid="briefing-ended">
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  data-testid="briefing-start-again"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Start Again
                </Button>
              </div>
            </div>
          )}

          {/* Floating action dock */}
          {showControls && (
            <div className="absolute bottom-6 right-6 flex items-center gap-2">
              {session.isAiSpeaking && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={session.stopCurrentResponse}
                  data-testid="briefing-stop-button"
                  aria-label="Stop speaking"
                  className="rounded-full bg-background/80 backdrop-blur"
                >
                  <Square className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant={session.isMuted ? "destructive" : "outline"}
                size="icon"
                onClick={session.toggleMute}
                data-testid="briefing-mute-button"
                aria-label={session.isMuted ? "Unmute microphone" : "Mute microphone"}
                className="rounded-full bg-background/80 backdrop-blur"
              >
                {session.isMuted ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="destructive"
                size="icon"
                onClick={handleClose}
                data-testid="briefing-end-button"
                aria-label="End briefing"
                className="rounded-full"
              >
                <PhoneOff className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </motion.div>
    </>,
    document.body,
  );
}

function deriveGridState(
  status: BriefingStatus,
  isAiSpeaking: boolean,
  isUserSpeaking: boolean,
  hasAudioVolume: boolean,
): GridVisualizerState {
  if (status === "connecting") return "connecting";
  if (status === "active") {
    // Use both transcript signal AND volume detection.
    // Transcript events arrive before audio plays and end before audio finishes,
    // so volume detection catches the tail of audio playback.
    if (isAiSpeaking || hasAudioVolume) return "speaking";
    if (isUserSpeaking) return "listening";
    return "listening";
  }
  return "disconnected";
}

export default BriefingOverlay;
