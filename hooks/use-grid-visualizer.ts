"use client";

import { useEffect, useRef, useState } from "react";

export type GridVisualizerState =
  | "disconnected"
  | "connecting"
  | "thinking"
  | "listening"
  | "speaking";

interface UseGridVisualizerOptions {
  state: GridVisualizerState;
  columns: number;
  rows: number;
  volumeBands: number[];
}

// ── Interval per state (ms) ─────────────────────────────────────────
// Matches LiveKit's sequencer cadence: each state has a distinct rhythm
// so the user can feel which state the agent is in without reading text.
const STATE_INTERVALS: Record<GridVisualizerState, number> = {
  connecting: 125,  // fast ring trace — urgency, "working on it"
  thinking: 150,    // fast bounce — processing
  listening: 500,   // slow pulse — calm, waiting
  speaking: 0,      // driven by volume, no sequencer
  disconnected: 0,  // static, no sequencer
};

/**
 * Sequencer-based grid visualizer inspired by LiveKit's BarVisualizer.
 *
 * Instead of running at 60fps with random lerp blending, this generates
 * a sequence of highlighted-index sets per state and steps through them
 * on a fixed interval timer. Speaking mode bypasses the sequencer and
 * maps volume bands directly to column heights.
 */
export function useGridVisualizer({
  state,
  columns,
  rows,
  volumeBands,
}: UseGridVisualizerOptions): boolean[][] {
  const [grid, setGrid] = useState<boolean[][]>(() => makeEmpty(rows, columns));
  const sequenceRef = useRef<[number, number][][]>([]);
  const indexRef = useRef(0);
  const volumeRef = useRef(volumeBands);

  volumeRef.current = volumeBands;

  // Generate sequence when state changes
  useEffect(() => {
    indexRef.current = 0;

    switch (state) {
      case "connecting":
        sequenceRef.current = generateConnectingSequence(rows, columns);
        break;
      case "thinking":
        sequenceRef.current = generateThinkingSequence(rows, columns);
        break;
      case "listening":
        sequenceRef.current = generateListeningSequence(rows, columns);
        break;
      case "speaking":
        sequenceRef.current = [];
        break;
      case "disconnected":
      default:
        sequenceRef.current = [];
        break;
    }

    // Render the first frame immediately for non-volume states
    if (state === "disconnected") {
      setGrid(renderDisconnected(rows, columns));
    } else if (state === "speaking") {
      setGrid(renderSpeaking(rows, columns, volumeRef.current, 0));
    } else if (sequenceRef.current.length > 0) {
      setGrid(renderSequenceFrame(rows, columns, sequenceRef.current[0]));
    }
  }, [state, rows, columns]);

  // Interval-based sequencer for connecting/thinking/listening
  useEffect(() => {
    const interval = STATE_INTERVALS[state];
    if (!interval) return;

    const seq = sequenceRef.current;
    if (seq.length === 0) return;

    const id = setInterval(() => {
      indexRef.current = (indexRef.current + 1) % seq.length;
      setGrid(renderSequenceFrame(rows, columns, seq[indexRef.current]));
    }, interval);

    return () => clearInterval(id);
  }, [state, rows, columns]);

  // rAF loop for speaking mode only (volume-driven, needs smooth updates)
  useEffect(() => {
    if (state !== "speaking") return;

    let rafId: number;
    let frameCount = 0;
    function tick() {
      frameCount++;
      setGrid(renderSpeaking(rows, columns, volumeRef.current, frameCount));
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [state, rows, columns]);

  return grid;
}

// ── Rendering ───────────────────────────────────────────────────────

function makeEmpty(rows: number, cols: number): boolean[][] {
  return Array.from({ length: rows }, () => new Array(cols).fill(false));
}

/** Render a grid from a set of highlighted [row, col] coordinates. */
function renderSequenceFrame(
  rows: number,
  cols: number,
  highlighted: [number, number][],
): boolean[][] {
  const grid = makeEmpty(rows, cols);
  for (const [r, c] of highlighted) {
    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      grid[r][c] = true;
    }
  }
  return grid;
}

/** Speaking: columns light from center outward proportional to volume.
 *  When volume is low/zero, a gentle wave animation keeps it visually alive. */
function renderSpeaking(
  rows: number,
  cols: number,
  volumeBands: number[],
  frameCount: number,
): boolean[][] {
  const grid = makeEmpty(rows, cols);
  const midRow = Math.floor(rows / 2);
  const hasVolume = volumeBands.some((v) => v > 0.05);

  for (let c = 0; c < cols; c++) {
    let vol = c < volumeBands.length ? volumeBands[c] : 0;

    // When no real volume data, generate a gentle sine wave so the
    // speaking state looks alive and distinct from listening/disconnected
    if (!hasVolume) {
      vol = 0.3 + 0.2 * Math.sin((frameCount * 0.05) + (c * 1.2));
    }

    const litRows = Math.round(vol * midRow);

    // Always light center row when speaking
    grid[midRow][c] = true;

    for (let offset = 1; offset <= litRows; offset++) {
      const above = midRow - offset;
      const below = midRow + offset;
      if (above >= 0) grid[above][c] = true;
      if (below < rows) grid[below][c] = true;
    }
  }
  return grid;
}

/** Disconnected: static center dot. */
function renderDisconnected(rows: number, cols: number): boolean[][] {
  const grid = makeEmpty(rows, cols);
  grid[Math.floor(rows / 2)][Math.floor(cols / 2)] = true;
  return grid;
}

// ── Sequence generators (LiveKit-inspired) ──────────────────────────

/**
 * Connecting: mirrored dot pairs converge from edges.
 * For a 5-col grid on the middle row: [0,4], [1,3], [2,2], [1,3], [0,4]
 * This creates a breathing, converging/diverging feel.
 */
function generateConnectingSequence(
  rows: number,
  cols: number,
): [number, number][][] {
  const midRow = Math.floor(rows / 2);
  const seq: [number, number][][] = [];

  // Converge: edges → center
  for (let i = 0; i < Math.ceil(cols / 2); i++) {
    seq.push([
      [midRow, i],
      [midRow, cols - 1 - i],
    ]);
  }

  // Diverge: center → edges
  for (let i = Math.floor(cols / 2) - 1; i >= 0; i--) {
    seq.push([
      [midRow, i],
      [midRow, cols - 1 - i],
    ]);
  }

  return seq;
}

/**
 * Thinking: single dot bounces left → right → left along middle row.
 * Fast rhythm (150ms) conveys "processing".
 */
function generateThinkingSequence(
  rows: number,
  cols: number,
): [number, number][][] {
  const midRow = Math.floor(rows / 2);
  const seq: [number, number][][] = [];

  // Left to right
  for (let c = 0; c < cols; c++) {
    seq.push([[midRow, c]]);
  }

  // Right to left (skip endpoints to avoid stutter)
  for (let c = cols - 2; c >= 1; c--) {
    seq.push([[midRow, c]]);
  }

  return seq;
}

/**
 * Listening: center dot pulses on/off.
 * Matches LiveKit's pattern: [center, sentinel, sentinel, ...]
 * At 500ms interval this creates a gentle breathing effect.
 */
function generateListeningSequence(
  rows: number,
  cols: number,
): [number, number][][] {
  const midRow = Math.floor(rows / 2);
  const midCol = Math.floor(cols / 2);

  return [
    [[midRow, midCol]], // on
    [],                 // off
  ];
}
