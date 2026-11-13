# MBC B2B discovery worker

Two Render services in one repo:

- **mbc-searxng** — SearXNG with JSON search enabled.
- **mbc-b2b-worker** — Overture Maps (DuckDB) + authenticated SearXNG proxy.

The worker is the only public entry point. SearXNG is reached over Render's
private network (`SEARXNG_INTERNAL_URL`), never by the app directly.

## Deploy on Render

Use the Blueprint (`render.yaml`) or create two Docker web services.

### Blueprint

Dashboard → **New + → Blueprint** → connect this repo. Render prompts for:

- `SEARXNG_SECRET` — `openssl rand -hex 32`
- `WORKER_TOKEN` — `openssl rand -hex 32` (32+ chars, required)

The worker's `SEARXNG_INTERNAL_URL` is filled automatically from the SearXNG
service's private `hostport`.

### Manual

**SearXNG**

- Runtime: Docker
- Dockerfile: `searxng/Dockerfile`
- Build context: `searxng`
- Port: `8080`
- Env: `SEARXNG_SECRET`

**Worker**

- Runtime: Docker
- Dockerfile: `./Dockerfile`
- Build context: `.`
- Port: `8787`
- Health check: `/health`
- Env:
  - `WORKER_TOKEN`
  - `SEARXNG_INTERNAL_URL=http://<searxng-service>:8080` (or the public URL)

## API

All data endpoints require `Authorization: Bearer <WORKER_TOKEN>` and are
rate-limited per client IP. `GET /health` is public.

`POST /api/overture/search`

```json
{
  "bbox": [120.79, 14.94, 120.98, 15.12],
  "categories": [],
  "name_terms": ["rice", "palay", "bigas", "palm oil", "cooking oil"],
  "limit": 300
}
```

`bbox` is `[minLng, minLat, maxLng, maxLat]`, max 2 degrees per side.

`POST /api/searxng/search`

```json
{ "q": "sari-sari store rice Candaba, Pampanga", "language": "en", "page": 1 }
```

## Run locally

```bash
npm install
npm run build
WORKER_TOKEN=$(openssl rand -hex 32) npm start
```

SearXNG is optional locally; without it the Overture endpoint still works.
