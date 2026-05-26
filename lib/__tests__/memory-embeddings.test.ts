import { afterEach, describe, expect, it, vi } from "vitest";

import {
  embedMemoryText,
  embedMemoryTexts,
  formatPgVectorLiteral,
  isMemoryVectorEnabled,
} from "../memory-embeddings";

describe("memory embeddings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("gates vector support on an exact true feature flag", () => {
    expect(isMemoryVectorEnabled({ MEMORY_VECTOR_ENABLED: "true" })).toBe(true);
    expect(isMemoryVectorEnabled({ MEMORY_VECTOR_ENABLED: "TRUE" })).toBe(false);
    expect(isMemoryVectorEnabled({ MEMORY_VECTOR_ENABLED: "false" })).toBe(false);
    expect(isMemoryVectorEnabled({})).toBe(false);
  });

  it("embeds text through the OpenAI embeddings endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedMemoryText("agent memory", {
      OPENAI_API_KEY: "test-key",
      MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
      MEMORY_EMBEDDING_DIMENSIONS: "2",
    });

    expect(result).toEqual({
      embedding: [0.1, 0.2],
      model: "text-embedding-3-small",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: "text-embedding-3-small",
      input: ["agent memory"],
      dimensions: 2,
    });
  });

  it("rejects configured dimensions that do not match vector column width", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      embedMemoryTexts(["agent memory"], {
        OPENAI_API_KEY: "test-key",
        MEMORY_VECTOR_ENABLED: "true",
        MEMORY_EMBEDDING_DIMENSIONS: "2",
      }),
    ).rejects.toThrow("database vector width 1536");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates embedding dimensions when configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.1, 0.2] }],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      embedMemoryTexts(["agent memory"], {
        OPENAI_API_KEY: "test-key",
        MEMORY_EMBEDDING_DIMENSIONS: "3",
      }),
    ).rejects.toThrow("OpenAI embedding dimensions mismatch");
  });

  it("formats pgvector literals for parameter casts", () => {
    expect(formatPgVectorLiteral([0.1, -0.2, 3])).toBe("[0.1,-0.2,3]");
    expect(() => formatPgVectorLiteral([])).toThrow(
      "Embedding must be a non-empty finite numeric vector",
    );
  });
});
