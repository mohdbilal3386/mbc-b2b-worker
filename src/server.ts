// Minimal HTTP API for the B2B discovery worker.
// Auth: Authorization: Bearer <WORKER_TOKEN> for all data endpoints.
// SearXNG is internal-only; this service is the authenticated proxy.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { queryOverture, type OvertureQuery } from "./overture.js";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.WORKER_TOKEN ?? "";
// Render's `hostport` service property is host:port without a scheme.
function searxngBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

const SEARXNG_INTERNAL_URL = searxngBaseUrl(
  process.env.SEARXNG_INTERNAL_URL ?? "http://searxng:8080",
);
const MAX_BODY = 64 * 1024;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 60 * 1000;

if (TOKEN.length < 32) {
  console.error("WORKER_TOKEN must be at least 32 characters. Refusing to start.");
  process.exit(1);
}

const buckets = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

function clientKey(req: IncomingMessage): string {
  // Cloudflare strips client-supplied CF-Connecting-IP. Fall back to the first
  // X-Forwarded-For hop only when a trusted reverse proxy sets it.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}

function rateLimited(req: IncomingMessage): boolean {
  const key = clientKey(req);
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const supplied = digest(header.slice("Bearer ".length));
  const expected = digest(TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function searxngSearch(body: {
  q?: unknown;
  categories?: unknown;
  language?: unknown;
  page?: unknown;
}) {
  const q = typeof body.q === "string" ? body.q.trim() : "";
  if (!q || q.length > 500) throw new Error("invalid query");

  const params = new URLSearchParams({
    q,
    format: "json",
    language: typeof body.language === "string" ? body.language.slice(0, 10) : "en",
    p: String(Math.min(Math.max(Number(body.page) || 1, 1), 10)),
    ...(typeof body.categories === "string" ? { categories: body.categories.slice(0, 40) } : {}),
  });

  const response = await fetch(`${SEARXNG_INTERNAL_URL}/search?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("SearXNG returned non-JSON");

  return response.json();
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    return json(res, 404, { error: "not found" });
  }

  if (!authorized(req)) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (rateLimited(req)) {
    res.setHeader("Retry-After", "3600");
    return json(res, 429, { error: "rate limit exceeded" });
  }

  try {
    const body = await readJson(req);

    if (req.url === "/api/overture/search") {
      const result = await queryOverture(body as OvertureQuery);
      return json(res, 200, result);
    }

    if (req.url === "/api/searxng/search") {
      const result = await searxngSearch(body as Record<string, unknown>);
      return json(res, 200, result);
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    // Log details server-side; never return filesystem/SQL/provider internals.
    console.error("worker request failed:", error);
    const message =
      error instanceof Error && /^(invalid|body too large)/i.test(error.message)
        ? error.message
        : "request failed";
    return json(res, 400, { error: message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`b2b worker listening on :${PORT} (build 2026-11-12b)`);
});

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
