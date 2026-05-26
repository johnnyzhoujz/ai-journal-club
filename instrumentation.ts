/**
 * Next.js instrumentation hook — runs once on server startup.
 *
 * Node.js v23's built-in fetch (undici) does NOT honor the HTTP_PROXY /
 * HTTPS_PROXY environment variables that curl and most other tools respect.
 * When a proxy is configured in the environment we wire up undici's
 * ProxyAgent as the global dispatcher so all server-side fetch() calls
 * route through it.
 */
export async function register() {
  // Only run in the Node.js runtime — Edge doesn't support undici/node:util
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY;

  if (proxyUrl && typeof globalThis.fetch !== "undefined") {
    try {
      const { setGlobalDispatcher, ProxyAgent } = await import("undici");
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      console.info(`[instrumentation] Global fetch proxy set to ${proxyUrl}`);
    } catch {
      // undici not available or proxy setup failed — fall through to default fetch
    }
  }
}
