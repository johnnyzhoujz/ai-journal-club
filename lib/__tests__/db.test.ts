import { describe, it, expect, vi, beforeEach } from "vitest";

describe("db module", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("throws when DATABASE_URL is not set and sql is called", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { sql } = await import("../db");
    expect(typeof sql).toBe("function");
    // Error is deferred to first call, not import time
    expect(() => sql`SELECT 1`).toThrow("DATABASE_URL");
  });

  it("exports sql function when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/testdb");
    vi.mock("@neondatabase/serverless", () => ({
      neon: vi.fn(() => vi.fn()),
    }));
    const { sql } = await import("../db");
    expect(sql).toBeDefined();
    expect(typeof sql).toBe("function");
  });

  it("exports transaction helper when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/testdb");
    const mockTransaction = vi.fn();
    const mockTag = Object.assign(vi.fn(), {
      transaction: mockTransaction,
    });
    vi.doMock("@neondatabase/serverless", () => ({
      neon: vi.fn(() => mockTag),
    }));

    const { transaction } = await import("../db");
    const queries = [{ text: "SELECT 1" }];
    transaction(queries as never);

    expect(transaction).toBeDefined();
    expect(typeof transaction).toBe("function");
    expect(mockTransaction).toHaveBeenCalledWith(queries);
  });
});
