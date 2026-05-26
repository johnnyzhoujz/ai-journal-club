// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

    expect(screen.getByText("Add your credentials in Vercel")).toBeInTheDocument();
    expect(screen.queryByText("DATABASE_URL / DATABASE_URL_UNPOOLED")).not.toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("X_BEARER_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("SUPADATA_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("CRON_SECRET")).toBeInTheDocument();
    expect(screen.getByText("AUTH_PASSWORD")).toBeInTheDocument();
    expect(screen.getByText("AUTH_SESSION_SECRET")).toBeInTheDocument();
    expect(screen.getByText("Values to provide")).toBeInTheDocument();
    expect(
      screen.getByText("Generated values to add after first deploy"),
    ).toBeInTheDocument();
    expect(screen.getByText("Optional ingestion providers")).toBeInTheDocument();
    expect(await screen.findByText(/^ajc_cron_/)).toBeInTheDocument();
    expect(await screen.findByText(/^ajc_session_/)).toBeInTheDocument();
    expect(screen.getByTestId("generated-cron-secret").textContent).toMatch(
      /^ajc_cron_[A-Za-z0-9_-]{48}$/,
    );
    expect(screen.getByTestId("generated-auth-session-secret").textContent).toMatch(
      /^ajc_session_[A-Za-z0-9_-]{48}$/,
    );
    expect(
      screen.getByText(/Add these values in Vercel Project Settings after the first deploy/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /add sources/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open setup guide/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss setup/i })).not.toBeInTheDocument();
  });

  it("can be forced open from setup page", async () => {
    localStorage.setItem("ai-journal-club:onboarding-dismissed", "true");

    render(<OnboardingPanel alwaysOpen />);

    expect(await screen.findByTestId("onboarding-panel")).toBeInTheDocument();
  });
});
