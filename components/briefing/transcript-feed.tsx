"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { BriefingTranscriptItem } from "@/hooks/use-briefing-session";

interface TranscriptFeedProps {
  items: BriefingTranscriptItem[];
  /** True when remote audio volume is detected (AI is actually speaking out loud) */
  isAudioPlaying: boolean;
  className?: string;
}

const SERIF = "Georgia, 'Times New Roman', serif";

// Words to advance per frame of ACTIVE audio playback + grace period.
// AI voices speak at ~160-180 WPM. With grace period smoothing,
// 3.8 words/sec ≈ 228 WPM to keep pace with continuous speech.
const WORDS_PER_SPEAKING_FRAME = 3.8 / 60;

/** Split text into sentences on . ! ? boundaries. */
function splitSentences(text: string): string[] {
  if (!text.trim()) return [];
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter((s) => s.trim());
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Paces sentence reveals at speech rate (~150 WPM).
 * Sentences arrive fast via transcript deltas, but this hook only
 * "reveals" them at the rate they'd be spoken, keeping text in sync
 * with audio playback.
 */
// Grace period (ms): after audio is detected, keep advancing for this long
// even if volume dips. Prevents stalling on brief silence between words.
// 600ms covers typical inter-word and short inter-clause pauses.
const AUDIO_GRACE_MS = 600;

function useSpeechPacedSentences(
  text: string,
  itemId: string,
  isAudioPlaying: boolean,
): { previous: string | null; current: string | null; next: string | null } {
  const allSentences = useMemo(() => splitSentences(text), [text]);
  const [revealedState, setRevealedState] = useState({
    itemId,
    index: -1,
  });
  const wordCursorRef = useRef(0);
  const rafRef = useRef(0);
  const isAudioPlayingRef = useRef(isAudioPlaying);
  const lastAudioTimeRef = useRef(0);

  useEffect(() => {
    isAudioPlayingRef.current = isAudioPlaying;
  }, [isAudioPlaying]);

  // Precompute cumulative word counts per sentence
  const cumulativeWords = useMemo(() => {
    return allSentences.reduce<number[]>((totals, sentence) => {
      const previousTotal = totals.at(-1) ?? 0;
      return [...totals, previousTotal + countWords(sentence)];
    }, []);
  }, [allSentences]);

  useEffect(() => {
    wordCursorRef.current = 0;
    lastAudioTimeRef.current = 0;

    function tick() {
      const now = performance.now();

      // Track when we last heard audio
      if (isAudioPlayingRef.current) {
        lastAudioTimeRef.current = now;
      }

      // Advance cursor if audio is playing OR within grace period.
      // This smooths out brief volume dips between words so the
      // cursor doesn't stutter.
      const withinGrace = now - lastAudioTimeRef.current < AUDIO_GRACE_MS;
      if (isAudioPlayingRef.current || withinGrace) {
        wordCursorRef.current += WORDS_PER_SPEAKING_FRAME;
      }

      // Find how many sentences the cursor has passed through
      let idx = -1;
      for (let i = 0; i < cumulativeWords.length; i++) {
        if (wordCursorRef.current >= cumulativeWords[i]) {
          idx = i;
        } else {
          break;
        }
      }

      setRevealedState((current) =>
        current.itemId === itemId && current.index === idx
          ? current
          : { itemId, index: idx },
      );
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [cumulativeWords, itemId]);

  const revealedIdx =
    revealedState.itemId === itemId ? revealedState.index : -1;

  // Map revealedIdx to the 3-line teleprompter
  if (revealedIdx < 0 && allSentences.length > 0) {
    // Cursor hasn't reached the first sentence yet — show it as upcoming
    return { previous: null, current: null, next: allSentences[0] };
  }

  const current = allSentences[revealedIdx] ?? null;
  const previous = revealedIdx > 0 ? allSentences[revealedIdx - 1] : null;
  const next = revealedIdx + 1 < allSentences.length ? allSentences[revealedIdx + 1] : null;

  return { previous, current, next };
}

function Teleprompter({ item, isAudioPlaying }: { item: BriefingTranscriptItem; isAudioPlaying: boolean }) {
  return <PacedTeleprompter item={item} isAudioPlaying={isAudioPlaying} />;
}

function PacedTeleprompter({ item, isAudioPlaying }: { item: BriefingTranscriptItem; isAudioPlaying: boolean }) {
  const { previous, current, next } = useSpeechPacedSentences(item.text, item.id, isAudioPlaying);

  return (
    <div className="space-y-1">
      {/* Previous sentence — faded */}
      <p
        className="text-muted-foreground/30 transition-all duration-500 min-h-[1.6em]"
        style={{ fontFamily: SERIF, fontSize: "17px", lineHeight: 1.6 }}
      >
        {previous ?? "\u00A0"}
      </p>

      {/* Current sentence — full brightness */}
      <p
        className="text-foreground transition-all duration-500 min-h-[1.6em]"
        style={{ fontFamily: SERIF, fontSize: "20px", lineHeight: 1.6 }}
      >
        {current ?? "\u00A0"}
      </p>

      {/* Next sentence — faded */}
      <p
        className="text-muted-foreground/30 transition-all duration-500 min-h-[1.6em]"
        style={{ fontFamily: SERIF, fontSize: "17px", lineHeight: 1.6 }}
      >
        {next ?? "\u00A0"}
      </p>
    </div>
  );
}

export function TranscriptFeed({ items, isAudioPlaying, className }: TranscriptFeedProps) {
  if (items.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-muted-foreground",
          className,
        )}
        style={{ fontFamily: SERIF, fontSize: "18px" }}
        data-testid="transcript-feed"
      >
        Waiting for briefing to start…
      </div>
    );
  }

  // Only show assistant messages — user text is hidden (inaccurate + distracting)
  const latestAssistant = [...items].reverse().find((i) => i.role === "assistant");

  if (!latestAssistant) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-muted-foreground",
          className,
        )}
        style={{ fontFamily: SERIF, fontSize: "18px" }}
        data-testid="transcript-feed"
      >
        Listening…
      </div>
    );
  }

  return (
    <div
      className={cn("relative px-6 py-4 overflow-hidden", className)}
      data-testid="transcript-feed"
    >
      <span className="font-semibold text-xs uppercase tracking-wider mb-3 block text-primary">
        AI Journal Club
      </span>

      <Teleprompter item={latestAssistant} isAudioPlaying={isAudioPlaying} />
    </div>
  );
}
