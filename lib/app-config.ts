const REQUIRED_RUNTIME_ENV = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CRON_SECRET",
  "AUTH_PASSWORD",
  "AUTH_SESSION_SECRET",
] as const;

export function getMissingRequiredRuntimeEnv(
  env: Record<string, string | undefined> = process.env,
) {
  return REQUIRED_RUNTIME_ENV.filter((key) => !env[key]?.trim());
}

export function isRuntimeConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  return getMissingRequiredRuntimeEnv(env).length === 0;
}

export function isAuthConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  return Boolean(env.AUTH_PASSWORD?.trim() && env.AUTH_SESSION_SECRET?.trim());
}
