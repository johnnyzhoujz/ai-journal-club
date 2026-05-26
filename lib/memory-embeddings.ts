const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
const DB_VECTOR_DIMENSIONS = 1536;

interface MemoryEmbeddingEnv {
  MEMORY_VECTOR_ENABLED?: string;
  MEMORY_EMBEDDING_MODEL?: string;
  MEMORY_EMBEDDING_DIMENSIONS?: string;
  OPENAI_API_KEY?: string;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{
    index?: number;
    embedding?: unknown;
  }>;
  error?: {
    message?: string;
  };
}

export interface MemoryEmbeddingResult {
  embedding: number[];
  model: string;
}

function getEmbeddingModel(env: MemoryEmbeddingEnv): string {
  return env.MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_MEMORY_EMBEDDING_MODEL;
}

function getExpectedEmbeddingDimensions(env: MemoryEmbeddingEnv): number | null {
  const raw = env.MEMORY_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("MEMORY_EMBEDDING_DIMENSIONS must be a positive integer");
  }
  return parsed;
}

function validateVectorDimensionsForDatabase(
  env: MemoryEmbeddingEnv,
  requestedDimensions: number | null,
) {
  if (!isMemoryVectorEnabled(env) || requestedDimensions == null) {
    return;
  }

  if (requestedDimensions !== DB_VECTOR_DIMENSIONS) {
    throw new Error(
      `MEMORY_EMBEDDING_DIMENSIONS must match database vector width ${DB_VECTOR_DIMENSIONS} when MEMORY_VECTOR_ENABLED=true`,
    );
  }
}

function validateEmbedding(
  value: unknown,
  expectedDimensions: number | null,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "number")
  ) {
    throw new Error("OpenAI embeddings response did not include a numeric vector");
  }

  if (expectedDimensions != null && value.length !== expectedDimensions) {
    throw new Error(
      `OpenAI embedding dimensions mismatch: expected ${expectedDimensions}, received ${value.length}`,
    );
  }

  return value;
}

export function isMemoryVectorEnabled(
  env: Pick<MemoryEmbeddingEnv, "MEMORY_VECTOR_ENABLED"> = process.env as Pick<
    MemoryEmbeddingEnv,
    "MEMORY_VECTOR_ENABLED"
  >,
): boolean {
  return env.MEMORY_VECTOR_ENABLED === "true";
}

export function formatPgVectorLiteral(embedding: number[]): string {
  if (
    embedding.length === 0 ||
    !embedding.every((value) => Number.isFinite(value))
  ) {
    throw new Error("Embedding must be a non-empty finite numeric vector");
  }

  return `[${embedding.join(",")}]`;
}

export async function embedMemoryTexts(
  texts: string[],
  env: MemoryEmbeddingEnv = process.env as MemoryEmbeddingEnv,
): Promise<{ embeddings: number[][]; model: string }> {
  const model = getEmbeddingModel(env);
  const requestedDimensions = getExpectedEmbeddingDimensions(env);
  validateVectorDimensionsForDatabase(env, requestedDimensions);
  const expectedDimensions =
    requestedDimensions ?? (isMemoryVectorEnabled(env) ? DB_VECTOR_DIMENSIONS : null);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  if (texts.length === 0) {
    return { embeddings: [], model };
  }
  const requestBody: {
    model: string;
    input: string[];
    dimensions?: number;
  } = {
    model,
    input: texts,
  };
  if (requestedDimensions != null) {
    requestBody.dimensions = requestedDimensions;
  }

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  let payload: OpenAIEmbeddingResponse;
  try {
    payload = JSON.parse(responseText) as OpenAIEmbeddingResponse;
  } catch {
    throw new Error(`OpenAI embeddings response was not valid JSON: ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(
      payload.error?.message ||
        `OpenAI embeddings request failed with status ${response.status}`,
    );
  }

  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error("OpenAI embeddings response did not match input count");
  }

  const embeddings = payload.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => validateEmbedding(item.embedding, expectedDimensions));

  return { embeddings, model };
}

export async function embedMemoryText(
  text: string,
  env: MemoryEmbeddingEnv = process.env as MemoryEmbeddingEnv,
): Promise<MemoryEmbeddingResult> {
  const { embeddings, model } = await embedMemoryTexts([text], env);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error("OpenAI embeddings response did not include an embedding");
  }
  return { embedding, model };
}
