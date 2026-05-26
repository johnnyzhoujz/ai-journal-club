export const AUTH_COOKIE_NAME = "auth";
export const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const AUTH_SESSION_VERSION = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type AuthSessionPayload = {
  v: typeof AUTH_SESSION_VERSION;
  iat: number;
  exp: number;
};

type CreateAuthSessionTokenOptions = {
  issuedAt?: number;
  expiresAt?: number;
  maxAgeSeconds?: number;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);

  try {
    const binary = atob(`${normalized}${padding}`);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

function getAuthSessionSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET;

  if (!secret) {
    throw new Error("AUTH_SESSION_SECRET is not configured");
  }

  return secret;
}

async function importAuthKey(
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(getAuthSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function parseAuthSessionPayload(
  payloadBytes: Uint8Array,
): AuthSessionPayload | null {
  try {
    const parsed = JSON.parse(
      textDecoder.decode(payloadBytes),
    ) as Partial<AuthSessionPayload>;

    if (
      parsed.v !== AUTH_SESSION_VERSION ||
      !isInteger(parsed.iat) ||
      !isInteger(parsed.exp) ||
      parsed.exp <= parsed.iat
    ) {
      return null;
    }

    return {
      v: AUTH_SESSION_VERSION,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

export async function createAuthSessionToken(
  options: CreateAuthSessionTokenOptions = {},
): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresAt =
    options.expiresAt ??
    issuedAt + (options.maxAgeSeconds ?? AUTH_SESSION_MAX_AGE_SECONDS);
  const payloadBytes = textEncoder.encode(
    JSON.stringify({
      v: AUTH_SESSION_VERSION,
      iat: issuedAt,
      exp: expiresAt,
    } satisfies AuthSessionPayload),
  );
  const key = await importAuthKey(["sign"]);
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      new Uint8Array(payloadBytes),
    ),
  );

  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(signature)}`;
}

export async function verifyAuthSessionToken(
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AuthSessionPayload | null> {
  const segments = token.split(".");

  if (segments.length !== 2) {
    return null;
  }

  const [payloadSegment, signatureSegment] = segments;
  const payloadBytes = decodeBase64Url(payloadSegment);
  const signatureBytes = decodeBase64Url(signatureSegment);

  if (!payloadBytes || !signatureBytes) {
    return null;
  }

  let key: CryptoKey;

  try {
    key = await importAuthKey(["verify"]);
  } catch {
    return null;
  }

  const isValid = await globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signatureBytes),
    new Uint8Array(payloadBytes),
  );

  if (!isValid) {
    return null;
  }

  const payload = parseAuthSessionPayload(payloadBytes);

  if (!payload || payload.exp <= nowSeconds) {
    return null;
  }

  return payload;
}

export function getAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  };
}

export function getClearedAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  };
}
