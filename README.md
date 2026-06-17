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
| csets kept (version-capped) | 931 | 931 | 931 |
| concepts (seed = members) | 363,020 | 363,020 | 363,020 |
| concepts (universe) | 688,800 | 427,741 | **550,157** |
| graph edges | 1,841,597 | 1,080,633 | **1,241,647** |
| **total Parquet bundle** | 53 MB | 39 MB | **45 MB** |

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
