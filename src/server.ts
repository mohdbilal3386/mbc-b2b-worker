// Minimal HTTP API for the B2B discovery worker.
// Auth: Authorization: Bearer <WORKER_TOKEN>.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { queryOverture, type OvertureQuery } from "./overture.js";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.WORKER_TOKEN ?? "";
const MAX_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "POST" || req.url !== "/api/overture/search") {
    return json(res, 404, { error: "not found" });
  }

  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    const body = (await readJson(req)) as OvertureQuery;
    const result = await queryOverture(body);
    return json(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "bad request";
    return json(res, 400, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`b2b worker listening on :${PORT}`);
});
