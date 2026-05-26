import type { SearchResult } from "@/lib/schema";

const BADGE_STYLES: Record<string, string> = {
  tweet: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  podcast: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  newsletter: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  paper: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

function formatDate(iso: string | null): string {
  if (!iso) return "Unknown date";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface SearchResultsProps {
  results: SearchResult[];
}

export function SearchResults({ results }: SearchResultsProps) {
  if (results.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-8 text-center">
        No results found.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {results.map((result) => (
        <a
          key={result.id}
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[result.source_type] ?? ""}`}
            >
              {result.source_type}
            </span>
            <span className="text-sm font-medium">{result.author_name}</span>
            <span className="text-sm text-muted-foreground">
              {formatDate(result.published_at)}
            </span>
          </div>
          {result.title && (
            <div className="font-medium text-sm mb-1">{result.title}</div>
          )}
          <div
            className="text-sm text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: result.snippet }}
          />
        </a>
      ))}
    </div>
  );
}
