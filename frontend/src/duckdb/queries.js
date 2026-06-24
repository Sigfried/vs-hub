// Ported query layer: the backend's SQL (archived/backend/routes/{db,graph}.py)
// re-expressed as DuckDB-Wasm queries. Each function returns the SAME result
// shape the original FastAPI endpoint returned, so DuckDbDataGetter can stand in
// for the HTTP DataGetter without the rest of the app noticing.
//
// See docs/read-only-port-plan.md for the endpoint-by-endpoint mapping.

import { query } from './db';
import bundleCache from '../../../data/bundle_cache.json';

// Helper: SQL IN-list of integers. Caller guarantees ids are numeric.
const inList = (ids) => (ids.length ? ids.map(Number).join(',') : 'NULL');
// Helper: SQL IN-list of quoted strings, escaping single quotes.
const inStr = (vals) =>
  vals.length ? vals.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',') : "NULL";

// all_csets columns stored as JSON text in Parquet (they were `json` in
// Postgres, so the original API delivered parsed objects). The UI dereferences
// them as objects — e.g. cset.counts.Members — so parse them back here.
const JSON_COLS = ['counts', 'flag_cnts'];
function parseJsonCols(rows) {
  for (const row of rows) {
    for (const col of JSON_COLS) {
      if (typeof row[col] === 'string') {
        try {
          row[col] = JSON.parse(row[col]);
        } catch {
          row[col] = null;
        }
      }
    }
  }
  return rows;
}

// get-all-csets — populate the select list.
// Original: SELECT a subset of all_csets ORDER BY created desc.
export async function getAllCsets() {
  return parseJsonCols(
    await query(`
      SELECT codeset_id,
             concept_set_version_title,
             alias,
             replace(left(codeset_created_at, 16), 'T', ' ') AS codeset_created_at,
             version,
             counts,
             distinct_person_cnt,
             total_cnt
      FROM all_csets
      ORDER BY codeset_created_at DESC
    `),
  );
}

// get-csets (codeset_ids) — full metadata for selected csets, plus a
// researchers dict per row (ported from get_row_researcher_ids_dict).
export async function getCsets(codesetIds) {
  const rows = parseJsonCols(
    await query(
      `SELECT * FROM all_csets WHERE codeset_id IN (${inList(codesetIds)})`,
    ),
  );
  for (const row of rows) row.researchers = researcherIdsDict(row);
  return rows;
}

// get-bundle-names — the N3C "bundles" (N3C Recommended, drug classes, COVID,
// etc.). Originally a FastAPI route reading bundle_cache.json server-side; here
// the cache is imported and bundled at build (no backend, no enclave-wrangler).
// Only return bundles that have codeset_ids, so the selector can't offer a
// bundle whose report would be empty. (The extraction guarantees every bundle
// codeset_id is present in the Parquet — see extract_subset.sql — so a non-empty
// bundle always yields a non-empty report.)
export function getBundleNames() {
  const { bundles } = bundleCache;
  return bundleCache.bundle_names.filter(
    (name) => (bundles[name]?.codeset_ids || []).length > 0,
  );
}

// bundle-report (bundle) — per-cset summary rows for one bundle's member csets.
// Ports backend/routes/db.py::bundle_report (the as_json=true branch). The
// original joined code_sets just to COUNT(distinct ...) versions per
// concept_set_name; the demo has no code_sets table, but all_csets already holds
// one row per version, so we derive the version count from all_csets itself.
export async function bundleReport(bundle) {
  const codesetIds = bundleCache.bundles[bundle]?.codeset_ids || [];
  if (!codesetIds.length) return [];
  return query(`
    WITH versions AS (
      SELECT concept_set_name, COUNT(DISTINCT codeset_id) AS versions
      FROM all_csets GROUP BY concept_set_name
    )
    SELECT ac.is_most_recent_version,
           ac.codeset_id,
           ac.concept_set_name,
           ac.alias,
           CAST(ac.codeset_created_at AS DATE) AS created_at,
           COALESCE(r.name, ac.codeset_created_by) AS created_by,
           CAST(json_extract_string(ac.counts, '$."Expression items"') AS INT) AS definition_concepts,
           CAST(json_extract_string(ac.counts, '$."Member only"') AS INT) AS expansion_concepts,
           ac.distinct_person_cnt,
           v.versions
    FROM all_csets ac
    JOIN versions v ON ac.concept_set_name = v.concept_set_name
    LEFT JOIN researcher r ON ac.codeset_created_by = r."multipassId"
    WHERE ac.codeset_id IN (${inList(codesetIds)})
    ORDER BY ac.is_most_recent_version, created_by, created_at, ac.alias
  `);
}

// get-cset-members-items (codeset_ids) — the comparison grid.
export async function getCsetMembersItems(codesetIds) {
  return query(
    `SELECT * FROM cset_members_items WHERE codeset_id IN (${inList(codesetIds)})`,
  );
}

// concepts (concept_ids) — concept metadata + counts.
export async function getConcepts(conceptIds) {
  return query(
    `SELECT * FROM concepts_with_counts WHERE concept_id IN (${inList(conceptIds)})`,
  );
}

// concept-search (search_str) — concept_ids whose name matches, ranked.
// Original ordered by -total_cnt|vocabulary_id|concept_name.
export async function conceptSearch(searchStr) {
  const like = `%${String(searchStr).replace(/'/g, "''")}%`;
  const rows = await query(`
    SELECT concept_id
    FROM concepts_with_counts
    WHERE concept_name ILIKE '${like}'
    ORDER BY total_cnt DESC, vocabulary_id, concept_name
  `);
  return rows;
}

// related-cset-concept-counts (concept_ids) — for a set of concepts, find every
// OTHER cset that contains them and how much it overlaps, broken down by vocab.
// Ports backend/routes/db.py::get_related_cset_concept_counts. Only true members
// count (csm = true), matching the original `AND csm` filter. Returns
//   { [codeset_id]: { concepts: <total distinct overlap>, [vocab]: <pct>, ... } }
// keyed by integer codeset_id — exactly the shape Csets.jsx consumes.
export async function relatedCsetConceptCounts(conceptIds = []) {
  if (!conceptIds.length) return {};
  const rows = await query(`
    SELECT CAST(codeset_id AS INTEGER) AS codeset_id,
           vocabulary_id,
           COUNT(DISTINCT concept_id) AS cnt
    FROM cset_members_items
    WHERE concept_id IN (${inList(conceptIds)})
      AND csm
    GROUP BY 1, 2
  `);

  // total distinct-concept overlap per cset (summed across its vocabs).
  const totals = {};
  for (const r of rows) totals[r.codeset_id] = (totals[r.codeset_id] || 0) + r.cnt;

  const vcounts = {};
  for (const r of rows) {
    const c = (vcounts[r.codeset_id] ||= {});
    c.concepts = totals[r.codeset_id];
    c[r.vocabulary_id] = r.cnt / totals[r.codeset_id];
  }
  return vcounts;
}

// researchers (multipassIds) — name/email/institution per researcher id, keyed
// by multipassId. Ports backend/routes/db.py::get_researchers, including the
// placeholder rows for ids absent from the researcher table.
export async function getResearchers(ids = []) {
  const rows = ids.length
    ? await query(
        `SELECT * FROM researcher WHERE "multipassId" IN (${inStr(ids)})`,
      )
    : [];
  const out = {};
  for (const r of rows) out[r.multipassId] = r;
  for (const id of ids) {
    if (!out[id]) {
      out[id] = { multipassId: id, name: 'unknown', emailAddress: 'unknown' };
    }
  }
  return out;
}

// concept-graph (codeset_ids, cids) — the hierarchy subgraph.
//
// Ports backend/routes/graph.py's concept_graph() WITHOUT networkx/pickle:
//   1. member concepts of the csets (+ extra cids)
//   2. hide configured vocabs / optionally non-standard concepts
//   3. one-hop descendants (was g.successors) via concept_graph edges
//   4. induced subgraph: edges with both endpoints in the concept set
//   5. assemble the response object (the bit graph.py flagged MOVE_TO_FRONT_END)
const DEFAULT_HIDE_VOCABS = ['RxNorm Extension'];

export async function conceptGraph(
  codesetIds,
  cids = [],
  hideVocabs = DEFAULT_HIDE_VOCABS,
  hideNonStandard = false,
) {
  // 1. member concepts (with vocab + standard flag) for the selected csets.
  const members = await query(`
    SELECT DISTINCT concept_id, vocabulary_id, standard_concept
    FROM cset_members_items
    WHERE codeset_id IN (${inList(codesetIds)})
    ${cids.length ? `UNION
    SELECT concept_id, vocabulary_id, standard_concept
    FROM concepts_with_counts
    WHERE concept_id IN (${inList(cids)})` : ''}
  `);

  // 2. partition into kept vs hidden (by vocab, optionally non-standard).
  const hiddenByVocab = {};
  const nonstandardHidden = [];
  const kept = [];
  for (const m of members) {
    if (hideVocabs.includes(m.vocabulary_id)) {
      (hiddenByVocab[m.vocabulary_id] ||= []).push(m.concept_id);
    } else if (hideNonStandard && m.standard_concept !== 'S') {
      nonstandardHidden.push(m.concept_id);
    } else {
      kept.push(m.concept_id);
    }
  }

  // 3. one-hop descendants of the kept concepts.
  const successors = kept.length
    ? await query(
        `SELECT DISTINCT target_id FROM concept_graph
           WHERE source_id IN (${inList(kept)})`,
      )
    : [];
  const conceptIds = Array.from(
    new Set([...kept, ...successors.map((r) => r.target_id)]),
  );

  // 4. induced subgraph: edges where both endpoints are in the concept set.
  const edges = conceptIds.length
    ? await query(
        `SELECT source_id, target_id FROM concept_graph
           WHERE source_id IN (${inList(conceptIds)})
             AND target_id IN (${inList(conceptIds)})`,
      )
    : [];

  // 5. assemble the response in the original shape.
  return {
    edges: edges.map((e) => [e.source_id, e.target_id]),
    concept_ids: conceptIds,
    missing_from_graph: [],
    hidden_by_vocab: hiddenByVocab,
    nonstandard_concepts_hidden: nonstandardHidden,
  };
}

// Researcher columns carried on each all_csets row that hold a researcher
// multipassId (joining to researcher.multipassId). Maps id → [roles], matching
// get_row_researcher_ids_dict. NOTE: reviewed_by and n3c_reviewer are omitted —
// they are 100% NULL in this dataset (and came through as `double`, not text).
const RESEARCHER_COLS = [
  'codeset_created_by',
  'container_created_by',
  'assigned_informatician',
  'assigned_sme',
];

function researcherIdsDict(row) {
  const roles = {};
  for (const col of RESEARCHER_COLS) {
    const id = row[col];
    if (!id) continue;
    (roles[id] ||= []).push(col);
  }
  return roles;
}
