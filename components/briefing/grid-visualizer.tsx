"use client";

import { cn } from "@/lib/utils";
import {
  useGridVisualizer,
  type GridVisualizerState,
} from "@/hooks/use-grid-visualizer";

const ROWS = 5;
const COLUMNS = 5;

const STATE_LABELS: Record<GridVisualizerState, string> = {
  disconnected: "Audio disconnected",
  connecting: "Connecting audio",
  thinking: "Processing",
  listening: "Listening",
  speaking: "Speaking",
};

interface GridVisualizerProps {
  state: GridVisualizerState;
  volumeBands: number[];
  size?: "sm" | "lg";
  className?: string;
}

export function GridVisualizer({
  state,
  volumeBands,
  size = "sm",
  className,
}: GridVisualizerProps) {
  const grid = useGridVisualizer({
    state,
    columns: COLUMNS,
    rows: ROWS,
    volumeBands,
  });

  const dotSize = size === "lg" ? "w-2.5 h-2.5" : "w-1 h-1";
  const gap = size === "lg" ? "gap-1.5" : "gap-0.5";

  return (
    <div
      className={cn("grid grid-cols-5", gap, className)}
      role="img"
      aria-label={STATE_LABELS[state]}
      data-testid="grid-visualizer"
    >
      {grid.flatMap((row, r) =>
        row.map((highlighted, c) => (
          <div
            key={`${r}-${c}`}
            className={cn(
              dotSize,
              "rounded-full bg-current transition-opacity duration-150",
              highlighted ? "opacity-100" : "opacity-10",
            )}
          />
        )),
      )}
    </div>
  );
}
