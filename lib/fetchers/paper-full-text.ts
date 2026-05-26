const HF_PAPER_MD_URL = (id: string) =>
  `https://huggingface.co/papers/${id}.md`;
const REQUEST_TIMEOUT_MS = 15_000;
const ARXIV_HTML_MIN_LENGTH = 5000;

export type FullTextSource = "arxiv_html" | "hf_page";

export interface PaperFullText {
  text: string;
  source: FullTextSource;
}

export type PaperFullTextFetchResult =
  | { status: "succeeded"; fullText: PaperFullText }
  | { status: "unavailable"; statusCode?: number; reason: string }
  | { status: "failed"; statusCode?: number; error: string };

export async function fetchPaperFullText(
  arxivId: string,
): Promise<PaperFullText | null> {
  const result = await fetchPaperFullTextWithStatus(arxivId);
  return result.status === "succeeded" ? result.fullText : null;
}

export async function fetchPaperFullTextWithStatus(
  arxivId: string,
): Promise<PaperFullTextFetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(HF_PAPER_MD_URL(arxivId), { signal: ctrl.signal });
    if (!res.ok) {
      console.warn(
        `fetchPaperFullText(${arxivId}): non-2xx status ${res.status}`,
      );
      if (res.status === 404 || res.status === 410) {
        return {
          status: "unavailable",
          statusCode: res.status,
          reason: `full text returned ${res.status}`,
        };
      }
      return {
        status: "failed",
        statusCode: res.status,
        error: `full text returned ${res.status}`,
      };
    }
    const text = (await res.text()).trim();
    if (!text) {
      return { status: "unavailable", reason: "full text body was empty" };
    }

    const source: FullTextSource =
      text.length > ARXIV_HTML_MIN_LENGTH && text.includes("\n## ")
        ? "arxiv_html"
        : "hf_page";
    return { status: "succeeded", fullText: { text, source } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `fetchPaperFullText(${arxivId}): ${message}`,
    );
    return { status: "failed", error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function pLimit(
  concurrency: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve()
          .then(fn)
          .then(
            (v) => {
              resolve(v);
              next();
            },
            (e) => {
              reject(e);
              next();
            },
          );
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
}
