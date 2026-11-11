# MBC B2B Overture worker

Small HTTP service that queries Overture Maps Places with DuckDB.

## API

`POST /api/overture/search` with `Authorization: Bearer $WORKER_TOKEN`.

```json
{ "bbox": [120.79, 14.94, 120.98, 15.12], "categories": ["restaurant"], "limit": 100 }
```

`GET /health` returns `{"ok":true}`.

## Env

- `WORKER_TOKEN` (required)
- `PORT` (default 8787)

## Run

```bash
npm install
npm run build
WORKER_TOKEN=... npm start
```
