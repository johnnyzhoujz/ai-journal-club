// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { AddSourceForm } from "../add-source-form";

describe("AddSourceForm", () => {
  const mockOnAdd = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnAdd.mockResolvedValue(true);
  });

  // --- X Account ---

  it("renders handle and name fields for x_account type", () => {
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    expect(screen.getByLabelText(/handle/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });

  it("renders detect button for x_account type", () => {
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    expect(screen.getByRole("button", { name: /detect/i })).toBeInTheDocument();
  });

  it("detect button is disabled when handle is empty", () => {
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    expect(screen.getByRole("button", { name: /detect/i })).toBeDisabled();
  });

  it("detect button calls /api/detect-x-profile and auto-fills name", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "Andrej Karpathy", handle: "karpathy", description: "AI researcher" }),
    });

    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "karpathy");
    await user.click(screen.getByRole("button", { name: /detect/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveValue("Andrej Karpathy");
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/detect-x-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "karpathy" }),
    });
  });

  it("does not auto-fill name from detect if name already entered (x_account)", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "Andrej Karpathy", handle: "karpathy", description: "" }),
    });

    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/name/i), "My Custom Name");
    await user.type(screen.getByLabelText(/handle/i), "karpathy");
    await user.click(screen.getByRole("button", { name: /detect/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/handle/i)).toHaveValue("karpathy");
    });

    expect(screen.getByLabelText(/name/i)).toHaveValue("My Custom Name");
  });

  it("shows error when detect returns 404 (x_account)", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "User @nonexistent not found on X" }),
    });

    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "nonexistent");
    await user.click(screen.getByRole("button", { name: /detect/i }));

    await waitFor(() => {
      expect(screen.getByText(/not found/i)).toBeInTheDocument();
    });
  });

  it("submits x_account with correct payload", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "karpathy");
    await user.type(screen.getByLabelText(/name/i), "Karpathy");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(mockOnAdd).toHaveBeenCalledWith({
      type: "x_account",
      name: "Karpathy",
      handle: "karpathy",
    });
  });

  it("strips @ from handle input", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "@karpathy");
    await user.type(screen.getByLabelText(/name/i), "Karpathy");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(mockOnAdd).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "karpathy" })
    );
  });

  it("shows validation error when name is empty for x_account", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "test");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    expect(mockOnAdd).not.toHaveBeenCalled();
  });

  it("shows validation error when handle is empty for x_account", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/name/i), "Test");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.getByText(/handle is required/i)).toBeInTheDocument();
    expect(mockOnAdd).not.toHaveBeenCalled();
  });

  // --- Podcast ---

  it("renders podcast fields with type selector and detect button", () => {
    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/youtube url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/channel handle/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /detect/i })).toBeInTheDocument();
  });

  it("detect button is disabled when URL is empty (podcast)", () => {
    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    expect(screen.getByRole("button", { name: /detect/i })).toBeDisabled();
  });

  it("detect button calls /api/detect-youtube and auto-fills fields", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: "youtube_channel",
        channel_handle: "lexfridman",
        name: null,
        url: "https://youtube.com/@lexfridman",
      }),
    });

    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/youtube url/i), "https://youtube.com/@lexfridman");
    await user.click(screen.getByRole("button", { name: /detect/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/channel handle/i)).toHaveValue("lexfridman");
    });

    expect(screen.getByLabelText(/name/i)).toHaveValue("");
    expect(mockFetch).toHaveBeenCalledWith("/api/detect-youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://youtube.com/@lexfridman" }),
    });
  });

  it("detect button auto-fills playlist_id for playlist URLs", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: "youtube_playlist",
        playlist_id: "PLrAXtmErZgOe",
        name: null,
        url: "https://youtube.com/playlist?list=PLrAXtmErZgOe",
      }),
    });

    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/youtube url/i), "https://youtube.com/playlist?list=PLrAXtmErZgOe");
    await user.click(screen.getByRole("button", { name: /detect/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/playlist id/i)).toHaveValue("PLrAXtmErZgOe");
    });

    expect(screen.getByLabelText(/name/i)).toHaveValue("");
  });

  it("shows error when detect returns 400 (podcast)", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Not a valid YouTube URL" }),
    });

    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/youtube url/i), "https://vimeo.com/123");
    await user.click(screen.getByRole("button", { name: /detect/i }));

    await waitFor(() => {
      expect(screen.getByText(/not a valid youtube url/i)).toBeInTheDocument();
    });
  });

  it("shows playlist_id field when youtube_playlist selected", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    await user.selectOptions(screen.getByLabelText(/type/i), "youtube_playlist");

    expect(screen.getByLabelText(/playlist id/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/channel handle/i)).not.toBeInTheDocument();
  });

  it("submits podcast (youtube_channel) with correct payload", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/youtube url/i), "https://youtube.com/@lexfridman");
    await user.type(screen.getByLabelText(/name/i), "Lex Fridman");
    await user.type(screen.getByLabelText(/channel handle/i), "lexfridman");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(mockOnAdd).toHaveBeenCalledWith({
      type: "podcast",
      name: "Lex Fridman",
      podcast_type: "youtube_channel",
      url: "https://youtube.com/@lexfridman",
      channel_handle: "lexfridman",
    });
  });

  it("submits podcast (youtube_playlist) with correct payload", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="podcast" onAdd={mockOnAdd} />);

    await user.selectOptions(screen.getByLabelText(/type/i), "youtube_playlist");
    await user.type(screen.getByLabelText(/youtube url/i), "https://youtube.com/playlist?list=PL123");
    await user.type(screen.getByLabelText(/name/i), "AI Playlist");
    await user.type(screen.getByLabelText(/playlist id/i), "PL123");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(mockOnAdd).toHaveBeenCalledWith({
      type: "podcast",
      name: "AI Playlist",
      podcast_type: "youtube_playlist",
      url: "https://youtube.com/playlist?list=PL123",
      playlist_id: "PL123",
    });
  });

  // --- Newsletter ---

  it("renders newsletter fields with detect feed button", () => {
    render(<AddSourceForm type="newsletter" onAdd={mockOnAdd} />);

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Feed URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /detect feed/i })).toBeInTheDocument();
  });

  it("detect feed button calls /api/detect-feed and auto-fills feed_url", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ feedUrl: "https://example.com/feed", name: "Example Blog" }),
    });

    render(<AddSourceForm type="newsletter" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.click(screen.getByRole("button", { name: /detect feed/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Feed URL")).toHaveValue("https://example.com/feed");
    });

    expect(screen.getByLabelText(/name/i)).toHaveValue("Example Blog");
    expect(mockFetch).toHaveBeenCalledWith("/api/detect-feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
  });

  it("shows error when detect feed returns 404", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "No RSS feed found at this URL" }),
    });

    render(<AddSourceForm type="newsletter" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText("URL"), "https://nofeed.com");
    await user.click(screen.getByRole("button", { name: /detect feed/i }));

    await waitFor(() => {
      expect(screen.getByText(/no rss feed found/i)).toBeInTheDocument();
    });
  });

  it("detect feed button is disabled when URL is empty", () => {
    render(<AddSourceForm type="newsletter" onAdd={mockOnAdd} />);

    expect(screen.getByRole("button", { name: /detect feed/i })).toBeDisabled();
  });

  it("submits newsletter with correct payload", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="newsletter" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/name/i), "AI Weekly");
    await user.type(screen.getByLabelText("URL"), "https://aiweekly.co");
    await user.type(screen.getByLabelText("Feed URL"), "https://aiweekly.co/feed");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(mockOnAdd).toHaveBeenCalledWith({
      type: "newsletter",
      name: "AI Weekly",
      url: "https://aiweekly.co",
      feed_url: "https://aiweekly.co/feed",
    });
  });

  // --- General ---

  it("clears form after successful submission", async () => {
    const user = userEvent.setup();
    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "test");
    await user.type(screen.getByLabelText(/name/i), "Test");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveValue("");
      expect(screen.getByLabelText(/handle/i)).toHaveValue("");
    });
  });

  it("shows server error on failed submission", async () => {
    const user = userEvent.setup();
    mockOnAdd.mockResolvedValueOnce(false);

    render(<AddSourceForm type="x_account" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/handle/i), "test");
    await user.type(screen.getByLabelText(/name/i), "Test");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to add source/i)).toBeInTheDocument();
    });
  });

  it("does not auto-fill name from detect-feed if name already entered", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ feedUrl: "https://example.com/feed", name: "Example Blog" }),
    });

    render(<AddSourceForm type="newsletter" onAdd={mockOnAdd} />);

    await user.type(screen.getByLabelText(/name/i), "My Custom Name");
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.click(screen.getByRole("button", { name: /detect feed/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Feed URL")).toHaveValue("https://example.com/feed");
    });

    expect(screen.getByLabelText(/name/i)).toHaveValue("My Custom Name");
  });
});
