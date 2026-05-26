"use client";

import { Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BriefingStatus } from "@/hooks/use-briefing-session";

interface BriefingControlsProps {
  status: BriefingStatus;
  isMuted: boolean;
  isAiSpeaking: boolean;
  elapsedSeconds: number;
  onToggleMute: () => void;
  onEnd: () => void;
  onStopResponse: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function BriefingControls({
  status,
  isMuted,
  isAiSpeaking,
  elapsedSeconds,
  onToggleMute,
  onEnd,
  onStopResponse,
}: BriefingControlsProps) {
  const isLive = status === "active";

  return (
    <div className="flex items-center justify-between px-6" data-testid="briefing-controls">
      <span
        className="text-xs text-muted-foreground font-mono tabular-nums w-12"
        data-testid="briefing-timer"
      >
        {formatTime(elapsedSeconds)}
      </span>

      <div className="flex items-center gap-3">
        {isLive && isAiSpeaking && (
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onStopResponse}
            data-testid="briefing-stop-button"
            aria-label="Stop speaking"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        )}

        {isLive && (
          <Button
            variant={isMuted ? "destructive" : "outline"}
            size="icon-sm"
            onClick={onToggleMute}
            data-testid="briefing-mute-button"
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            title={isMuted ? "Unmute after briefing to ask questions" : "Mute microphone"}
          >
            {isMuted ? (
              <MicOff className="h-3.5 w-3.5" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
          </Button>
        )}

        <Button
          variant="destructive"
          size="icon-sm"
          onClick={onEnd}
          data-testid="briefing-end-button"
          aria-label="End briefing"
          className="rounded-full"
        >
          <PhoneOff className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Spacer to balance the timer on the left */}
      <div className="w-12" />
    </div>
  );
}
