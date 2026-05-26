"use client";

import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Digest } from "@/lib/schema";
import { DigestPanel } from "./digest-panel";
import { ChatPanel } from "./chat-panel";

interface DeepDiveOverlayProps {
  digest: Digest;
  onClose: () => void;
}

export function DeepDiveOverlay({ digest, onClose }: DeepDiveOverlayProps) {
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
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <>
      {/* Backdrop */}
      <motion.div
        data-testid="deep-dive-backdrop"
        className="fixed inset-0 z-50 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />

      {/* Content */}
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
      >
        <div className="relative w-[95vw] max-w-7xl h-[90vh] bg-background rounded-xl border border-border shadow-2xl overflow-hidden pointer-events-auto flex">
          {/* Close button */}
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3 z-10"
            onClick={onClose}
            aria-label="Close deep dive"
          >
            <X className="h-4 w-4" />
          </Button>

          {/* Left: Digest panel */}
          <div className="w-1/2 border-r border-border hidden md:block">
            <DigestPanel digest={digest} />
          </div>

          {/* Right: Chat panel */}
          <motion.div
            className="flex-1 min-w-0"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.1, type: "spring", damping: 25, stiffness: 300 }}
          >
            <ChatPanel digest={digest} />
          </motion.div>
        </div>
      </motion.div>
    </>,
    document.body,
  );
}

export default DeepDiveOverlay;
