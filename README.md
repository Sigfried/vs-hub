# TermHub demo — serverless revival

**Live: https://sigfried.github.io/vs-hub/**

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

**Live: https://sigfried.github.io/vs-hub/** (read-only demo, deployed from
`main` via GitHub Actions — see `.github/workflows/deploy-pages.yml`).

- [x] Data-pipeline design: bundle-driven, version-capped extraction; size
      verified against the dump (~95 MB). SQL + script written.
- [x] Run the extraction locally: produced `data/public/*.parquet` (45 MB
      bundle, committed for Pages to serve).
- [x] **Phase 1 — read-only demo**: load seed csets; cset select / compare /
      members grid; concept search; concept metadata; hierarchy graph; related
      concept sets + researchers; bundle selector + bundle report (About page,
      backed by `bundle_cache.json` — no enclave-wrangler/backend). Deployed and
      confirmed live.
- [ ] Phase 2 — save csets back to GitHub (designed, deferred). See
      [docs/saveback-design.md](docs/saveback-design.md).
- [ ] Curated demo experience / guided onboarding (planned separately, likely
      in `../hub`) — the raw app is powerful but dense for first-time users.
- [ ] Move hosting off GitHub Pages (Cloudflare Pages / Netlify) for proper SPA
      routing: Pages needs a `404.html` fallback, so deep-link refreshes render
      but return an HTTP 404 status.

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

**Concept universe = cset members + their DESCENDANTS.** TermHub deliberately
surfaces each cset concept's descendants so users can see and add them while
authoring. `MAX_DEPTH` controls expansion: `0` = full transitive closure (all
descendants, any depth), `N` = down to N levels. Full closure risks the
`concept_ancestor` explosion (it's the bulk of the 30 GB dump), so the build
reports `concepts_seed` vs `concepts_universe` — measure, and if the bundle is
too big re-run with a bounded depth.

### Restore + run

Recommended: restore into Postgres once, explore/iterate from DuckDB via the
postgres scanner (DuckDB writes the Parquet).

```bash
# 1) restore the plain-SQL dump into local Postgres (one-time, ~30 GB):
createdb n3c
psql -d n3c -f ~/github-repos/TermHub/n3c_backup_20251210.dmp
# objects land in schema "n3c_backup_20251210" (not "n3c").

# 2) build the subset (DuckDB attaches Postgres read-only, writes Parquet):
MODE=pg PG_CONN="dbname=n3c host=localhost" SCHEMA=n3c_backup_20251210 \
  ./data/scripts/build_subset.sh

# knobs:
#   MAX_DEPTH=0                 full descendant closure (default)
#   MAX_DEPTH=3                 cap descendant expansion to 3 levels
#   MAX_VERSIONS=2              keep fewer versions per value set
#   HIDE_VOCABS="RxNorm Extension"  vocabs whose descendants are excluded
#                               (members in them are still kept); "" to disable
#   COMPLETE_VOCABS="LOINC,ICDO3,HemOnc,ICD10PCS,SNOMED,RxNorm"
#                               pull in ALL used (total_cnt>0) concepts of these
#                               vocabs so authors can browse them; "" to disable
```

Produces `data/public/*.parquet`. The build prints a size report; aim to keep
the total bundle ≲ a few hundred MB so it fits in browser memory.

### Measured sizes (against the restored dump, MAX_DEPTH=0)

| | full closure | RxNorm Ext excluded | + vocab completion (default) |
|---|---|---|---|
| csets kept (version-capped) | 950 | 950 | 950 |
| concepts (seed = members) | 362,846 | 362,846 | 362,846 |
| concepts (universe) | — | — | **549,930** |
| graph edges | — | — | **1,240,775** |
| **total Parquet bundle** | — | — | **47 MB** |

The version cap keeps ≤3 versions per value set, **but never prunes a
codeset_id a bundle explicitly points to** — so every bundle in
`bundle_cache.json` is fully represented in the demo (the `csets kept` count
includes the handful of extra bundle-referenced interior versions). One empty
(0-member) cset that a bundle referenced was deleted from `bundle_cache.json`
rather than carried as an empty report.

The concept universe = cset members + their descendants (US-only, so RxNorm
Extension descendants are excluded — TermHub hides that vocab by default;
members in it are still kept) + all *used* concepts of clinically central vocabs
(labs, oncology, procedures, standard backbone) so authors can browse/search
them. All well within the browser memory budget.

## Source / provenance

Original app: `jhu-bids/TermHub`. The archived backend query patterns this port
follows live in that repo under `archived/backend/routes/{db,graph,cset_crud}.py`.
The hierarchy graph that the original served from a 330 MB networkx pickle is
just the `concept_ancestor` (min_levels_of_separation = 1) edge list — here it's
a small Parquet edge list queried directly in DuckDB, no Python.
