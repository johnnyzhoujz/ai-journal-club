"use client";

import { AnimatePresence, motion } from "motion/react";
import type { GridVisualizerState } from "@/hooks/use-grid-visualizer";
import { cn } from "@/lib/utils";

const STATE_COPY: Record<GridVisualizerState, { label: string; tone: string }> = {
  disconnected: { label: "Disconnected", tone: "text-muted-foreground" },
  connecting: { label: "Connecting...", tone: "text-muted-foreground" },
  thinking: { label: "Processing...", tone: "text-muted-foreground" },
  listening: { label: "Listening", tone: "text-foreground" },
  speaking: { label: "Speaking", tone: "text-foreground" },
};

const STATE_DOT: Record<GridVisualizerState, string> = {
  disconnected: "bg-muted-foreground/40",
  connecting: "bg-muted-foreground/60",
  thinking: "bg-muted-foreground/60",
  listening: "bg-emerald-500",
  speaking: "bg-foreground",
};

interface BriefingStatusIndicatorProps {
  state: GridVisualizerState;
  className?: string;
}

export function BriefingStatusIndicator({
  state,
  className,
}: BriefingStatusIndicatorProps) {
  const copy = STATE_COPY[state];
  const dot = STATE_DOT[state];

  return (
    <div
      className={cn("flex items-center gap-3", className)}
      data-testid="briefing-status-indicator"
      data-state={state}
    >
      <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
        {(state === "speaking" || state === "listening") && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping",
              dot,
            )}
          />
        )}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", dot)} />
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copy.label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className={cn("text-2xl tracking-tight", copy.tone)}
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          data-testid="briefing-status-label"
        >
          {copy.label}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
