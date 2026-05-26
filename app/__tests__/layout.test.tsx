// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock next/font/google to avoid font loading in tests
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter" }),
  JetBrains_Mono: () => ({ variable: "--font-mono" }),
}));

// Mock next/link to render a plain anchor
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

// Mock next-themes
vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

import RootLayout from "../layout";

// RootLayout renders <html> and <body>, which jsdom doesn't handle well in render().
// We extract just the nav/content portion by rendering the body content directly.
// Since layout exports the full <html> tree, we test the navigation component separately.
function NavWrapper({ children }: { children?: React.ReactNode }) {
  // We'll test the layout by rendering it and checking the output
  return <RootLayout>{children ?? <div>test content</div>}</RootLayout>;
}

describe("RootLayout navigation", () => {
  it('exports metadata with title "AI Journal Club"', async () => {
    const { metadata } = await import("../layout");
    expect(metadata.title).toBe("AI Journal Club");
  });

  it('renders "AI Journal Club" branding in nav', () => {
    const { container } = render(<NavWrapper />);
    expect(container.textContent).toContain("AI Journal Club");
  });

  it("renders Dashboard link pointing to /", () => {
    render(<NavWrapper />);
    const link = screen.getByRole("link", { name: /dashboard/i });
    expect(link).toHaveAttribute("href", "/");
  });

  it("renders Sources link pointing to /sources", () => {
    render(<NavWrapper />);
    const link = screen.getByRole("link", { name: /sources/i });
    expect(link).toHaveAttribute("href", "/sources");
  });

  it("renders Digests link pointing to /digests", () => {
    render(<NavWrapper />);
    const link = screen.getByRole("link", { name: /digests/i });
    expect(link).toHaveAttribute("href", "/digests");
  });

  it("renders Research link pointing to /research", () => {
    render(<NavWrapper />);
    const link = screen.getByRole("link", { name: /research/i });
    expect(link).toHaveAttribute("href", "/research");
  });

  it("renders all 4 nav links", () => {
    render(<NavWrapper />);
    const nav = screen.getByRole("navigation");
    const links = nav.querySelectorAll("a");
    expect(links.length).toBeGreaterThanOrEqual(4);
  });

  it("renders children content", () => {
    render(
      <NavWrapper>
        <p>Child content here</p>
      </NavWrapper>,
    );
    expect(screen.getByText("Child content here")).toBeInTheDocument();
  });

  it("wraps content in ThemeProvider", () => {
    render(<NavWrapper />);
    expect(screen.getByTestId("theme-provider")).toBeInTheDocument();
  });

  it("renders theme toggle in nav bar", () => {
    render(<NavWrapper />);
    // ThemeToggle renders Light/Dark/System buttons
    expect(screen.getByRole("button", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /system/i })).toBeInTheDocument();
  });
});
