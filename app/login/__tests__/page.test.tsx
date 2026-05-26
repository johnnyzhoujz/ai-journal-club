// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({}),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import LoginPage from "../page";

describe("LoginPage", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders "AI Journal Club" as the page heading', () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("heading", { name: /ai journal club/i }),
    ).toBeInTheDocument();
  });

  it("renders password input and submit button", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in|log in/i })).toBeInTheDocument();
  });

  it("submit button is disabled when password is empty", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /sign in|log in/i })).toBeDisabled();
  });

  it("submit button is enabled when password has text", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/password/i), "test123");
    expect(screen.getByRole("button", { name: /sign in|log in/i })).toBeEnabled();
  });

  it("calls POST /api/auth/login on submit", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    await user.type(screen.getByLabelText(/password/i), "test123");
    await user.click(screen.getByRole("button", { name: /sign in|log in/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/auth/login");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body.password).toBe("test123");
  });

  it("redirects to / on success via full page reload", async () => {
    const user = userEvent.setup();

    // Mock window.location.href assignment
    const locationSpy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      href: window.location.href,
    } as Location);
    const hrefSetter = vi.fn();
    Object.defineProperty(window.location, "href", {
      set: hrefSetter,
      configurable: true,
    });

    render(<LoginPage />);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    await user.type(screen.getByLabelText(/password/i), "test123");
    await user.click(screen.getByRole("button", { name: /sign in|log in/i }));

    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith("/");
    });

    locationSpy.mockRestore();
  });

  it("shows error message on 401", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid password" }),
    });

    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in|log in/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid password/i)).toBeInTheDocument();
    });
  });

  it("shows error message on network failure", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

    await user.type(screen.getByLabelText(/password/i), "test123");
    await user.click(screen.getByRole("button", { name: /sign in|log in/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
    });
  });

  it("submits form via Enter key", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    await user.type(screen.getByLabelText(/password/i), "test123{Enter}");

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/auth/login");
    expect(options.method).toBe("POST");
  });
});
