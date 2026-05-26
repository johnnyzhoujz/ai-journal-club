import { createHmac } from "node:crypto";

import { sql } from "@/lib/db";

const CLIENT_IP_HEADER_NAMES = [
  "x-vercel-forwarded-for",
  "x-forwarded-for",
  "x-real-ip",
] as const;

export const LOCAL_DEV_CLIENT_IP = "local-dev";

export const DEFAULT_BRIEFING_RATE_LIMITS = {
  call: 5,
  tool: 30,
  trace: 60,
} as const;

export type RateLimitRouteKey =
  | "briefing/call"
  | "briefing/tool"
  | "briefing/trace";

export interface ClientIpInfo {
  clientIp: string;
  clientIpHash: string;
}

export interface ConsumeRateLimitOptions {
  headers: Headers;
  routeKey: RateLimitRouteKey | string;
  limit: number;
}

export interface ConsumeRateLimitResult extends ClientIpInfo {
  routeKey: string;
  limit: number;
  count: number;
  allowed: boolean;
  bucket: string | null;
}

export class MissingClientIpError extends Error {
  code = "missing_client_ip" as const;

  constructor() {
    super("No canonical client IP header was present");
  }
}

export class MissingClientIpHashSecretError extends Error {
  code = "missing_client_ip_hash_secret" as const;

  constructor() {
    super("AUTH_SESSION_SECRET environment variable is required");
  }
}

function getFirstForwardedValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const candidate = value.split(",")[0]?.trim();
  return candidate ? candidate : null;
}

function getClientIpHashSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    throw new MissingClientIpHashSecretError();
  }
  return secret;
}

export function extractCanonicalClientIp(headers: Headers): string | null {
  for (const headerName of CLIENT_IP_HEADER_NAMES) {
    const candidate = getFirstForwardedValue(headers.get(headerName));
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

export function deriveCanonicalClientIp(headers: Headers): string {
  const clientIp = extractCanonicalClientIp(headers);

  if (clientIp) {
    return clientIp;
  }

  if (process.env.NODE_ENV === "production") {
    throw new MissingClientIpError();
  }

  return LOCAL_DEV_CLIENT_IP;
}

export function hashClientIp(clientIp: string): string {
  return createHmac("sha256", getClientIpHashSecret())
    .update(clientIp)
    .digest("hex");
}

export function deriveClientIpInfo(headers: Headers): ClientIpInfo {
  const clientIp = deriveCanonicalClientIp(headers);
  return {
    clientIp,
    clientIpHash: hashClientIp(clientIp),
  };
}

export async function consumeRateLimit(
  options: ConsumeRateLimitOptions,
): Promise<ConsumeRateLimitResult> {
  const { clientIp, clientIpHash } = deriveClientIpInfo(options.headers);
  const rows = await sql`
    INSERT INTO rate_limit_buckets (ip_hash, route_key, bucket, count)
    VALUES (${clientIpHash}, ${options.routeKey}, date_trunc('minute', NOW()), 1)
    ON CONFLICT (ip_hash, route_key, bucket)
    DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count, bucket::text
  `;

  const row = rows[0] as { count?: number | string; bucket?: string } | undefined;
  const count = Number(row?.count ?? 0);

  return {
    clientIp,
    clientIpHash,
    routeKey: options.routeKey,
    limit: options.limit,
    count,
    allowed: count <= options.limit,
    bucket: row?.bucket ?? null,
  };
}
