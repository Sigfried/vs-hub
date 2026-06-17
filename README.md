# TermHub demo — serverless revival

A free, public, linkable demo of [TermHub](https://github.com/jhu-bids/TermHub),
the N3C concept/value-set authoring and comparison tool. Funding ended; this
revives it with **no backend and no hosted database** by running
[DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview) in the browser over a
small Parquet subset of the original N3C data, served as static files from
GitHub Pages.

> Portfolio framing: *revived a defunded full-stack analytics app as a
> serverless DuckDB-Wasm SPA — eliminated the entire backend tier and hosted
> Postgres, kept the analytic UI.*

## Architecture

```
React frontend  →  DuckDB-Wasm (in the browser)  →  Parquet files (static)
```

No FastAPI backend, no Postgres. The original backend's query logic becomes SQL
strings the frontend hands to DuckDB-Wasm. See
[docs/read-only-port-plan.md](docs/read-only-port-plan.md).

## Status

- [x] Data-pipeline design: bundle-driven, version-capped extraction; size
      verified against the dump (~95 MB). SQL + script written.
- [ ] Run the extraction locally (install DuckDB, restore/attach the dump,
      produce `data/public/*.parquet`).
- [ ] **Phase 1 — read-only demo** (current focus): load seed csets; cset
      select / compare / members grid; concept search; concept metadata;
      hierarchy graph.
- [ ] Phase 2 — save csets back to GitHub (designed, deferred until Phase 1
      works). See [docs/saveback-design.md](docs/saveback-design.md).

## Layout

```
data/
  bundle_cache.json           # N3C bundle -> codeset_id map (the extraction driver)
  sql/extract_subset.sql      # filter the N3C dump → demo Parquet subset
  scripts/build_subset.sh     # run the extraction (local; needs DuckDB + dump)
  public/*.parquet            # the committed demo bundle (Pages serves these)
frontend/                     # React + Vite + DuckDB-Wasm (ported from archived TermHub)
docs/
  read-only-port-plan.md      # how the backend queries become DuckDB-Wasm SQL
  saveback-design.md          # deferred: save-cset-to-GitHub design
```

## Data pipeline (runs locally — 32 GB dump, not in any sandbox)

The source is `~/github-repos/TermHub/n3c_backup_20251210.dmp` (plain-SQL
Postgres dump). The dump already contains the derived tables materialized, so
extraction **filters** them rather than rebuilding the original DDL — which
preserves N3C patient counts and the original cset authors automatically.

**Driver = the N3C bundles** (`data/bundle_cache.json`: N3C Recommended, drug
classes, COVID sets, etc. — 499 csets across 43 bundles), expanded to include
each value set's version history, then **capped to ≤3 versions per value set**
(earliest + latest + one evenly-spaced middle) so the version UI stays clean.

```bash
# A) restore the dump into local Postgres, then:
MODE=pg PG_CONN="dbname=n3c host=localhost" SCHEMA=n3c ./data/scripts/build_subset.sh
# B) or, if you've imported into a DuckDB file:
MODE=duckdb DUCKDB_FILE=data/duckdb/n3c.duckdb SCHEMA=n3c ./data/scripts/build_subset.sh
# Override the version cap: MAX_VERSIONS=2 ./data/scripts/build_subset.sh
```

Produces `data/public/*.parquet`.

### Measured sizes (from the dump)

| | bundle only | + all versions | **+ versions, capped ≤3** |
|---|---|---|---|
| csets | 499 | 1,326 | **931** |
| distinct concepts | 325K | 370K | ~360K |
| graph edges | 852K | 944K | ~930K |
| **est. Parquet bundle** | ~63 MB | ~125 MB | **~95 MB** |

Versions are cheap: they reuse concepts (+14%) and edges (+11%); the growth is
member rows. All options are well within the browser memory budget (≲ a few
hundred MB). The cap mainly tames outliers (one value set had 96 versions → 3).

## Source / provenance

Original app: `jhu-bids/TermHub`. The archived backend query patterns this port
follows live in that repo under `archived/backend/routes/{db,graph,cset_crud}.py`.
The hierarchy graph that the original served from a 330 MB networkx pickle is
just the `concept_ancestor` (min_levels_of_separation = 1) edge list — here it's
a small Parquet edge list queried directly in DuckDB, no Python.
