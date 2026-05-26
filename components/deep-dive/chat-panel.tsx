"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Digest } from "@/lib/schema";
import { MessageBubble } from "./message-bubble";
import { ChatInput } from "./chat-input";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  digest: Digest;
}

export function ChatPanel({ digest }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(
    async (userMessage: string) => {
      const userMsg: Message = { role: "user", content: userMessage };
      const updatedMessages = [...messages, userMsg];

      setMessages(updatedMessages);
      setError(null);
      setIsStreaming(true);

      // Add placeholder for assistant response
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      try {
        const response = await fetch("/api/deep-dive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            digestId: digest.id,
            messages: updatedMessages,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Request failed");
        }

        if (!response.body) throw new Error("No response body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = {
              ...last,
              content: last.content + chunk,
            };
            return updated;
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setError(msg);
        // Remove empty assistant placeholder on error
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last.role === "assistant" && !last.content) {
            return prev.slice(0, -1);
          }
          return prev;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, digest.id],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Ask anything about this digest and its sources.
          </p>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            role={msg.role}
            content={msg.content}
            isStreaming={isStreaming && i === messages.length - 1 && msg.role === "assistant"}
          />
        ))}
        {error && (
          <p className="text-sm text-destructive text-center py-2">{error}</p>
        )}
        <div ref={messagesEndRef} />
      </div>
      <ChatInput onSend={handleSend} disabled={isStreaming} />
    </div>
  );
}
