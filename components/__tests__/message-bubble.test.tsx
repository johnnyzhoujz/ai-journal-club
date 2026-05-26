// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "../deep-dive/message-bubble";

describe("MessageBubble", () => {
  it("renders user message text", () => {
    render(<MessageBubble role="user" content="What about the tweets?" />);
    expect(screen.getByText("What about the tweets?")).toBeInTheDocument();
  });

  it("renders assistant message text", () => {
    render(
      <MessageBubble role="assistant" content="The tweets covered AI topics." />,
    );
    expect(screen.getByText(/The tweets covered AI topics/)).toBeInTheDocument();
  });

  it("renders assistant markdown as HTML", () => {
    render(
      <MessageBubble
        role="assistant"
        content="Check out **bold text** and [a link](https://example.com)"
      />,
    );
    const strong = screen.getByText("bold text");
    expect(strong.tagName).toBe("STRONG");

    const link = screen.getByRole("link", { name: "a link" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("shows loading dots when streaming with empty content", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="" isStreaming />,
    );
    const dots = container.querySelectorAll("[data-testid='loading-dot']");
    expect(dots.length).toBe(3);
  });

  it("does not show loading dots when content is present", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="Some text" isStreaming />,
    );
    const dots = container.querySelectorAll("[data-testid='loading-dot']");
    expect(dots.length).toBe(0);
  });

  it("applies different alignment for user vs assistant", () => {
    const { container: userContainer } = render(
      <MessageBubble role="user" content="Hello" />,
    );
    const { container: assistantContainer } = render(
      <MessageBubble role="assistant" content="Hi there" />,
    );

    const userBubble = userContainer.querySelector("[data-slot='message-bubble']");
    const assistantBubble = assistantContainer.querySelector(
      "[data-slot='message-bubble']",
    );

    expect(userBubble?.className).toMatch(/justify-end/);
    expect(assistantBubble?.className).toMatch(/justify-start/);
  });

  // -- Edge cases -----------------------------------------------------------

  it("renders very long messages (5000+ chars) without error", () => {
    const longContent = "A".repeat(5000);
    const { container } = render(
      <MessageBubble role="assistant" content={longContent} />,
    );
    expect(container.textContent).toContain("A".repeat(100));
  });

  it("renders whitespace-only content without crash", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="   \n\t  " />,
    );
    expect(container.querySelector("[data-slot='message-bubble']")).toBeInTheDocument();
  });
});
