"use client";

import { useState, useRef, useEffect } from "react";

/**
 * Smoothly reveals streamed text using requestAnimationFrame.
 *
 * Two modes:
 * - "text": fast reveal for chat UIs. Flushes immediately when streaming ends.
 * - "speech": constant-rate reveal (~15 chars/sec) for voice UIs. Never flushes.
 *   The text just keeps rolling at speech pace until caught up, regardless of
 *   whether the streaming flag is true or false. This prevents the "text dump"
 *   that happens when transcript events complete before audio finishes.
 */

// --- Text mode constants (default, used by deep-dive MessageBubble) ---
const TEXT_MIN_CHARS_PER_FRAME = 2;
const TEXT_CATCH_UP_RATIO = 0.12;

// --- Speech mode: ~150 WPM ≈ 15 chars/sec at 60fps ---
const SPEECH_CHARS_PER_FRAME = 0.25;

export type StreamBufferPace = "text" | "speech";

export function useStreamBuffer(
  targetText: string,
  isStreaming: boolean,
  pace: StreamBufferPace = "text",
): string {
  const [displayedText, setDisplayedText] = useState(targetText);
  const displayedLenRef = useRef(targetText.length);
  const targetRef = useRef(targetText);
  const rafRef = useRef<number>(0);
  const accumulatorRef = useRef(0);

  useEffect(() => {
    targetRef.current = targetText;
  }, [targetText]);

  useEffect(() => {
    if (pace === "text") {
      // --- Text mode: original behavior ---
      if (!isStreaming) {
        cancelAnimationFrame(rafRef.current);
        displayedLenRef.current = targetRef.current.length;
        setDisplayedText(targetRef.current);
        return;
      }

      function textTick() {
        const target = targetRef.current;
        const currentLen = displayedLenRef.current;

        if (currentLen < target.length) {
          const remaining = target.length - currentLen;
          const advance = Math.max(
            TEXT_MIN_CHARS_PER_FRAME,
            Math.ceil(remaining * TEXT_CATCH_UP_RATIO),
          );
          const newLen = Math.min(currentLen + advance, target.length);
          displayedLenRef.current = newLen;
          setDisplayedText(target.slice(0, newLen));
        }

        rafRef.current = requestAnimationFrame(textTick);
      }

      rafRef.current = requestAnimationFrame(textTick);
      return () => cancelAnimationFrame(rafRef.current);
    }

    // --- Speech mode: constant rate, never flush ---
    // The rAF loop runs as long as there's text to reveal.
    // It does NOT care about isStreaming — it just keeps pacing.
    // This prevents dumps when transcript events fire before audio ends.

    accumulatorRef.current = 0;

    function speechTick() {
      const target = targetRef.current;
      const currentLen = displayedLenRef.current;

      if (currentLen < target.length) {
        accumulatorRef.current += SPEECH_CHARS_PER_FRAME;
        if (accumulatorRef.current >= 1) {
          const advance = Math.floor(accumulatorRef.current);
          accumulatorRef.current -= advance;
          const newLen = Math.min(currentLen + advance, target.length);
          displayedLenRef.current = newLen;
          setDisplayedText(target.slice(0, newLen));
        }
      }

      rafRef.current = requestAnimationFrame(speechTick);
    }

    rafRef.current = requestAnimationFrame(speechTick);
    return () => cancelAnimationFrame(rafRef.current);
    // Speech mode: the loop runs continuously at speech rate.
  }, [pace, isStreaming, targetText]);

  return displayedText;
}
