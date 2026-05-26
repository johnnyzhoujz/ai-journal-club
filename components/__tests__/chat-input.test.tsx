// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatInput } from "../deep-dive/chat-input";

describe("ChatInput", () => {
  it("calls onSend with input text on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Hello{Enter}");

    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("clears input after sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "Hello{Enter}");

    expect(textarea).toHaveValue("");
  });

  it("does not send empty messages", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "{Enter}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send whitespace-only messages", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "   {Enter}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("allows newline with Shift+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.type(textarea, "line1{Shift>}{Enter}{/Shift}line2");

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line1\nline2");
  });

  it("disables textarea and button when disabled prop is true", () => {
    render(<ChatInput onSend={vi.fn()} disabled />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    expect(textarea).toBeDisabled();

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("has a send button", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});
