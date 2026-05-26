// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    x_accounts: [],
    podcasts: [],
    newsletters: [],
    papers: { enabled: false, id: null },
  }),
}));

import SourcesPage from "../page";

describe("SourcesPage", () => {
  it("renders the page with heading 'Sources'", () => {
    render(<SourcesPage />);

    expect(screen.getByRole("heading", { name: /sources/i })).toBeInTheDocument();
  });

  it("renders the SourceTabs component", async () => {
    render(<SourcesPage />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /x accounts/i })).toBeInTheDocument();
    });
  });
});
