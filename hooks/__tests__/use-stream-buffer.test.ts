// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamBuffer } from "../use-stream-buffer";

describe("useStreamBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns full text immediately when not streaming", () => {
    const { result } = renderHook(() =>
      useStreamBuffer("Hello world", false),
    );
    expect(result.current).toBe("Hello world");
  });

  it("returns empty string initially when streaming starts with empty content", () => {
    const { result } = renderHook(() => useStreamBuffer("", true));
    expect(result.current).toBe("");
  });

  it("gradually reveals text during streaming via rAF", () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useStreamBuffer(text, streaming),
      { initialProps: { text: "", streaming: true } },
    );

    // Simulate chunks arriving
    rerender({ text: "Hello world, this is a test", streaming: true });

    // Before any animation frame, displayed text should still be empty
    expect(result.current).toBe("");

    // Advance a few animation frames
    act(() => {
      // Simulate several rAF callbacks
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    // After some frames, some text should be revealed but possibly not all
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThanOrEqual(
      "Hello world, this is a test".length,
    );
  });

  it("flushes remaining text when streaming ends", () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useStreamBuffer(text, streaming),
      { initialProps: { text: "", streaming: true } },
    );

    // Simulate text arriving
    rerender({ text: "Complete response text here", streaming: true });

    // Advance a couple frames (partial reveal)
    act(() => {
      vi.advanceTimersByTime(32);
    });

    // Now stop streaming — should flush everything
    rerender({ text: "Complete response text here", streaming: false });

    expect(result.current).toBe("Complete response text here");
  });

  it("shows full content for non-streaming messages", () => {
    const { result } = renderHook(() =>
      useStreamBuffer("Already complete message", false),
    );
    expect(result.current).toBe("Already complete message");
  });

  it("handles empty content when not streaming", () => {
    const { result } = renderHook(() => useStreamBuffer("", false));
    expect(result.current).toBe("");
  });
});
