// DuckDB-Wasm boot + Parquet registration.
//
// Replaces the entire FastAPI backend + hosted Postgres: a SQL engine running
// in the browser tab, reading the demo Parquet bundle over HTTP from the static
// host. See docs/read-only-port-plan.md.

import * as duckdb from '@duckdb/duckdb-wasm';

// The Parquet files that make up the demo bundle (produced by
// data/scripts/build_subset.sh). Each becomes a DuckDB view of the same name.
export const TABLES = [
  'all_csets',
  'cset_members_items',
  'concepts_with_counts',
  'concept_graph',
  'vocabulary',
  'domain',
  'relationship',
];

let _dbPromise = null;

// Instantiate DuckDB-Wasm once (idempotent). Uses jsDelivr-hosted bundles so
// there is nothing to self-host; the worker is created from a blob URL.
async function instantiate() {
  const BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(BUNDLES);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], {
      type: 'text/javascript',
    }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pewWorker);
  URL.revokeObjectURL(workerUrl);
  return db;
}

// Register each Parquet file under `${dataUrl}/<table>.parquet` as a view.
// Uses registerFileURL so DuckDB streams via HTTP range requests (httpfs) —
// only the bytes a query needs are fetched, not the whole file.
async function registerParquet(db, dataUrl) {
  const conn = await db.connect();
  try {
    for (const t of TABLES) {
      const url = `${dataUrl}/${t}.parquet`;
      await db.registerFileURL(
        `${t}.parquet`,
        url,
        duckdb.DuckDBDataProtocol.HTTP,
        false,
      );
      await conn.query(
        `CREATE OR REPLACE VIEW ${t} AS
           SELECT * FROM read_parquet('${t}.parquet')`,
      );
    }
  } finally {
    await conn.close();
  }
}

// Get the shared DuckDB instance with the demo bundle registered. `dataUrl` is
// where the Parquet files live (default: the app's own /data path on the static
// host). Call once at app start; cached thereafter.
export function getDb(dataUrl = `${import.meta.env.BASE_URL}data`) {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = await instantiate();
      await registerParquet(db, dataUrl);
      return db;
    })();
  }
  return _dbPromise;
}

// Run a SQL query and return plain row objects (Arrow → JS). Booleans, bigints,
// etc. are converted to JS-native values so result shapes match the old API.
export async function query(sql, params) {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const stmt = params ? await conn.prepare(sql) : null;
    const result = stmt ? await stmt.query(...params) : await conn.query(sql);
    return result.toArray().map((row) => normalizeRow(row.toJSON()));
  } finally {
    await conn.close();
  }
}

// Arrow returns BigInt for int64 columns; the old JSON API returned numbers.
// Coerce BigInt → Number where it fits, leaving everything else as-is.
function normalizeRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      typeof v === 'bigint'
        ? v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER
          ? Number(v)
          : v.toString()
        : v;
  }
  return out;
}
