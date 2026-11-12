// Overture Maps Places query service (Node + DuckDB).
//
// Runs outside Cloudflare Workers because DuckDB/GeoParquet cannot run there.
// Queries a bounded bbox from the current Overture release discovered through
// the official STAC catalog. No planet-wide import; no Supabase writes.

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

const STAC_CATALOG = "https://stac.overturemaps.org/catalog.json";
const S3_BUCKET = "s3://overturemaps-us-west-2/release";
const RELEASE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BBOX_DEGREES = 2;

export type OverturePlace = {
  id: string;
  name: string | null;
  category: string | null;
  taxonomy_primary: string | null;
  confidence: number | null;
  operating_status: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
};

export type OvertureQuery = {
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  categories?: string[];
  name_terms?: string[];
  limit?: number;
};

let cachedRelease: { version: string; fetchedAt: number } | null = null;
let cachedConnection: DuckDBConnection | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function latestRelease(): Promise<string> {
  if (cachedRelease && Date.now() - cachedRelease.fetchedAt < RELEASE_TTL_MS) {
    return cachedRelease.version;
  }
  const res = await fetch(STAC_CATALOG, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Overture STAC HTTP ${res.status}`);
  const data = (await res.json()) as { latest?: string };
  if (!data.latest) throw new Error("Overture STAC has no latest release");
  cachedRelease = { version: data.latest, fetchedAt: Date.now() };
  return data.latest;
}

async function connection(): Promise<DuckDBConnection> {
  if (cachedConnection) return cachedConnection;
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL httpfs; LOAD httpfs;");
  await conn.run("SET s3_region='us-west-2';");
  cachedConnection = conn;
  return conn;
}

// One connection, serialised queries. DuckDB connections are not concurrent.
function serialised<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const run = queue.then(async () => fn(await connection()));
  queue = run.catch(() => undefined);
  return run;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Word-start match so "Price" does not match "rice", but "RiceMart" does.
function nameTermPattern(term: string): string {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return `(^|[^a-z])${escaped}`;
}

export async function queryOverture(
  input: OvertureQuery,
): Promise<{ release: string; places: OverturePlace[] }> {
  const [minLng, minLat, maxLng, maxLat] = input.bbox;
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
    throw new Error("Invalid bbox");
  }
  if (maxLng <= minLng || maxLat <= minLat) throw new Error("Invalid bbox order");
  if (maxLng - minLng > MAX_BBOX_DEGREES || maxLat - minLat > MAX_BBOX_DEGREES) {
    throw new Error(`bbox too large (max ${MAX_BBOX_DEGREES} degree)`);
  }

  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 1000);
  const categories = (input.categories ?? []).filter((c) => /^[a-z0-9_]+$/.test(c));
  const categoryFilter = categories.length
    ? `AND basic_category IN (${categories.map((c) => `'${c}'`).join(",")})`
    : "";

  const nameTerms = (input.name_terms ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 3 && term.length <= 40 && /^[a-z0-9 ]+$/.test(term))
    .slice(0, 20);
  const nameFilter = nameTerms.length
    ? `AND (${nameTerms
        .map(
          (term) =>
            `regexp_matches(lower(coalesce(names.primary, '') || ' ' || coalesce(taxonomy.primary, '') || ' ' || coalesce(basic_category, '')), '${nameTermPattern(term)}')`,
        )
        .join(" OR ")})`
    : "";

  const release = await latestRelease();
  const glob = `${S3_BUCKET}/${release}/theme=places/type=place/*.parquet`;

  const sql = `
    SELECT
      id,
      names.primary AS name,
      basic_category AS category,
      taxonomy.primary AS taxonomy_primary,
      confidence,
      operating_status,
      websites[1] AS website,
      phones[1] AS phone,
      emails[1] AS email,
      addresses[1].freeform AS address,
      addresses[1].locality AS locality,
      addresses[1].region AS region,
      (bbox.xmin + bbox.xmax) / 2 AS lng,
      (bbox.ymin + bbox.ymax) / 2 AS lat
    FROM read_parquet('${glob}', hive_partitioning=1)
    WHERE bbox.xmin < ${maxLng}
      AND bbox.xmax > ${minLng}
      AND bbox.ymin < ${maxLat}
      AND bbox.ymax > ${minLat}
      ${categoryFilter}
      ${nameFilter}
    LIMIT ${limit}
  `;

  const rows = await serialised(async (conn) => {
    const result = await conn.run(sql);
    return result.getRowObjects();
  });

  const places = rows.map((row) => ({
    id: String(row.id),
    name: text(row.name),
    category: text(row.category),
    taxonomy_primary: text(row.taxonomy_primary),
    confidence: number(row.confidence),
    operating_status: text(row.operating_status),
    website: text(row.website),
    phone: text(row.phone),
    email: text(row.email),
    address: text(row.address),
    locality: text(row.locality),
    region: text(row.region),
    lat: number(row.lat),
    lng: number(row.lng),
  }));

  return { release, places };
}
