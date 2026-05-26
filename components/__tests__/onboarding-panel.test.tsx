// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingPanel } from "../onboarding-panel";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("OnboardingPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows first-run credential guidance", async () => {
    render(<OnboardingPanel />);

    expect(await screen.findByText("First run")).toBeInTheDocument();
    expect(screen.getByText("DATABASE_URL / DATABASE_URL_UNPOOLED")).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("X_BEARER_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("SUPADATA_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("CRON_SECRET")).toBeInTheDocument();
    expect(screen.getByText("AUTH_PASSWORD / AUTH_SESSION_SECRET")).toBeInTheDocument();
  });

  it("dismisses once in localStorage", async () => {
    const user = userEvent.setup();
    render(<OnboardingPanel />);

    await user.click(await screen.findByRole("button", { name: /dismiss setup/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("onboarding-panel")).not.toBeInTheDocument();
    });
    expect(localStorage.getItem("ai-journal-club:onboarding-dismissed")).toBe("true");
  });

  it("can be forced open from setup page", async () => {
    localStorage.setItem("ai-journal-club:onboarding-dismissed", "true");

    render(<OnboardingPanel alwaysOpen />);

    expect(await screen.findByTestId("onboarding-panel")).toBeInTheDocument();
  });
});
