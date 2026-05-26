import type { Source, FeedItemInsert, TweetMeta, TopReply } from "../schema";

const X_API_BASE = "https://api.x.com/2";
const TWEET_LOOKBACK_HOURS = 24;
const MAX_TWEETS_PER_USER = 3;
const MAX_REPLIES_PER_TWEET = 5;

interface XUser {
  id: string;
  username: string;
  name: string;
  description: string;
}

interface XTweet {
  id: string;
  text: string;
  created_at: string;
  note_tweet?: { text: string };
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
  referenced_tweets?: { type: string; id: string }[];
}

/**
 * Fetch top replies for a tweet using the search/recent endpoint.
 * Returns up to MAX_REPLIES_PER_TWEET replies sorted by likes, or null on any error.
 */
export async function fetchTopReplies(
  tweetId: string,
  bearerToken: string
): Promise<TopReply[] | null> {
  try {
    const res = await fetch(
      `${X_API_BASE}/tweets/search/recent?` +
        `query=conversation_id:${tweetId}` +
        `&tweet.fields=public_metrics,author_id` +
        `&user.fields=username,name` +
        `&expansions=author_id` +
        `&max_results=10`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );

    if (!res.ok) {
      console.error(`X API: Reply search failed for tweet ${tweetId}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const tweets: { id: string; text: string; author_id: string; public_metrics?: { like_count: number } }[] = data.data || [];
    if (tweets.length === 0) return null;

    // Build user lookup map from includes
    const userMap: Record<string, { username: string; name: string }> = {};
    for (const user of data.includes?.users || []) {
      userMap[user.id] = { username: user.username, name: user.name };
    }

    // Filter out the original tweet, sort by likes, take top N
    return tweets
      .filter((t) => t.id !== tweetId)
      .sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0))
      .slice(0, MAX_REPLIES_PER_TWEET)
      .map((t) => ({
        authorHandle: userMap[t.author_id]?.username || "unknown",
        authorName: userMap[t.author_id]?.name || "Unknown",
        text: t.text,
        likes: t.public_metrics?.like_count || 0,
      }));
  } catch (err) {
    console.error(
      `X API: Reply search error for tweet ${tweetId}: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/**
 * Fetch recent tweets from X accounts.
 * Preserves the expected X API request shape used by the ingestion worker.
 * Dedup is handled by the DB constraint — no state parameter needed.
 */
export async function fetchXContent(
  sources: Source[],
  bearerToken: string
): Promise<FeedItemInsert[]> {
  const results: FeedItemInsert[] = [];
  const cutoff = new Date(
    Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000
  );

  // Batch lookup all user IDs (up to 100 per request)
  const handles = sources.map((s) => s.handle).filter(Boolean) as string[];
  const userMap: Record<string, XUser> = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(",")}&user.fields=name,description`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        console.error(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of data.data || []) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          username: user.username,
          name: user.name,
          description: user.description || "",
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          console.error(
            `X API: User not found: ${err.value || err.detail}`
          );
        }
      }
    } catch (err) {
      console.error(
        `X API: User lookup error: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Fetch recent tweets per user
  for (const source of sources) {
    const handle = source.handle;
    if (!handle) continue;

    const userData = userMap[handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
          `max_results=5` +
          `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
          `&exclude=retweets,replies` +
          `&start_time=${cutoff.toISOString()}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        if (res.status === 429) {
          console.error("X API: Rate limited, skipping remaining accounts");
          break;
        }
        console.error(
          `X API: Failed to fetch tweets for @${handle}: HTTP ${res.status}`
        );
        continue;
      }

      const data = await res.json();
      const allTweets: XTweet[] = data.data || [];

      let count = 0;
      for (const t of allTweets) {
        if (count >= MAX_TWEETS_PER_USER) break;

        const tweetMeta: TweetMeta = {
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote:
            t.referenced_tweets?.some((r) => r.type === "quoted") || false,
          quotedTweetId:
            t.referenced_tweets?.find((r) => r.type === "quoted")?.id || null,
          topReplies: null,
        };

        // Fetch top replies if this tweet has any
        if (tweetMeta.replies > 0) {
          tweetMeta.topReplies = await fetchTopReplies(t.id, bearerToken);
        }

        results.push({
          source_type: "tweet",
          external_id: t.id,
          source_id: source.id,
          content: t.note_tweet?.text || t.text,
          url: `https://x.com/${handle}/status/${t.id}`,
          author_name: source.name,
          author_handle: handle,
          author_bio: userData.description,
          published_at: t.created_at,
          tweet_meta: tweetMeta,
        });

        count++;
      }

      // Rate limit courtesy delay
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(
        `X API: Error fetching @${handle}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return results;
}
