# Read-only port plan — backend queries → DuckDB-Wasm

How each original FastAPI endpoint becomes browser-side DuckDB SQL. Source:
`jhu-bids/TermHub` → `archived/backend/routes/{db,graph}.py` and
`archived/frontend/src/state/DataGetter.jsx`.

## The porting seam

The React app routes **all** data access through one class:
`src/state/DataGetter.jsx` — an `apiCalls` table (one entry per endpoint, with
`api`, `makeQueryString`, `cacheSlice`, `key`, `apiResultShape`) consumed by
`fetchAndCacheItems()` / `axiosCall()`. Components never call the network
directly; they call the getter and get back documented shapes.

**Plan:** implement a `DuckDbDataGetter` that keeps the exact same public
surface (`fetchAndCacheItems`, the `apiCalls` shapes, the cache contract) but,
instead of `axiosCall` → HTTP, dispatches each `api` name to a SQL query against
DuckDB-Wasm and returns the identical result shape. The rest of the app
(components, DataCache, state) is untouched. One file replaces the network tier.

Boot sequence: instantiate DuckDB-Wasm → register/attach the Parquet files
(`all_csets`, `cset_members_items`, `concepts_with_counts`, `concept_graph`,
`vocabulary`, `domain`, `relationship`) as views → hand the getter a query
function.

## Endpoint-by-endpoint

Only the endpoints the demo features use. Everything else in the backend
(enclave upload, db refresh, logging, researchers, usage, bundle reports) is
out of scope.

### `get-all-csets` → `all_csets` slice
Original: `SELECT codeset_id, concept_set_version_title, alias, codeset_created_at,
version, counts, distinct_person_cnt, total_cnt FROM all_csets ORDER BY created DESC`.
DuckDB: same query over `all_csets.parquet`. Result shape: array of keyed obj
(key `codeset_id`). Trivial.

### `get-csets` (codeset_ids) → `csets` slice
Original: `SELECT * FROM all_csets WHERE codeset_id = ANY(:ids)`, then attaches a
`researchers` dict per row (from RESEARCHER_COLS). DuckDB: same `WHERE codeset_id
IN (...)`. The `researchers` derivation (`get_row_researcher_ids_dict`) moves to
~10 lines of TS in the getter, reading the same researcher-id columns off each
row. Key `codeset_id`.

### `get-cset-members-items` (codeset_ids) → `cset_members_items` slice
Original: `SELECT * FROM cset_members_items WHERE codeset_id = ANY(:ids)`.
DuckDB: identical over `cset_members_items.parquet`. This is the comparison
grid. Multipart key `codeset_id.concept_id`.

### `concepts` (concept_ids) → `concepts` slice
Original: `SELECT * FROM concepts_with_counts WHERE concept_id IN (...)`.
DuckDB: identical. Key `concept_id`. Keep the frontend's `createStubForMissingKey`
behavior for ids absent from the subset.

### `concept-search` (search_str) → `search_str` slice
Original: `SELECT concept_id FROM concepts_with_counts WHERE concept_name ILIKE
'%str%' ORDER BY <sort cols>`. DuckDB supports `ILIKE`. Identical. Returns
concept_id list (frontend then fetches `concepts`).

### `concept-graph` (codeset_ids, cids) → `concept-graph` slice  ← the only non-trivial one
Original builds a networkx DiGraph from a pickle and does:
1. member concepts for the csets (`get_cset_members_items` cols
   concept_id/vocabulary_id/standard_concept) + any extra `cids`;
2. filter hidden vocabs (`hide_vocabs`, default `['RxNorm Extension']`) and
   optionally non-standard concepts;
3. one-hop descendants: for each kept concept, `g.successors(node)`;
4. induced subgraph: keep edges where both endpoints are in the concept set;
5. return `{edges, concept_ids, missing_from_graph, hidden_by_vocab,
   nonstandard_concepts_hidden}`.

**Port (no networkx, no pickle):**
- Step 1: SQL select from `cset_members_items` (+ `concepts_with_counts` for
  extra cids).
- Step 2: SQL `WHERE vocabulary_id NOT IN (...)` (+ optional `standard_concept
  = 'S'`); compute the `hidden_by_vocab` groupings with a `GROUP BY vocabulary_id`.
- Step 3: `SELECT target_id FROM concept_graph WHERE source_id IN (<concept set>)`
  (one-hop successors).
- Step 4: induced subgraph — `SELECT source_id, target_id FROM concept_graph
  WHERE source_id IN (S) AND target_id IN (S)` where S = concept set ∪ step-3
  results.
- Step 5: assemble the response object in ~20 lines of TS (the original code
  even flags this as `MOVE_TO_FRONT_END()`).

`concept_graph.parquet` = `concept_ancestor WHERE min_levels_of_separation = 1`,
bounded to the subset (see `data/sql/extract_subset.sql`). If the hierarchy view
looks too sparse because step-3 successors fall outside the subset, relax the
extraction's target-side filter (documented inline in the SQL) and add those
concept rows.

## Out of scope (read-only demo)
`researchers`, `usage`, `n3c-comparison-rpt`, `bundle-report`, `related-cset-
concept-counts`, `next-api-call-group-id`, all `cset_crud` upload routes, all
`enclave_wrangler`, db-refresh/load/initialize. Stub the getter entries that the
UI hard-requires (e.g. return `null`/empty) and hide the UI affordances that
depend on the rest.

## Verification
Pick 2–3 demo csets that overlap and have hierarchy depth. Confirm against the
shapes documented in `DataGetter.jsx`'s `apiCalls`: select list populates,
comparison grid renders, search returns hits, a concept's hierarchy shows edges.
