// Ported query layer: the backend's SQL (archived/backend/routes/{db,graph}.py)
// re-expressed as DuckDB-Wasm queries. Each function returns the SAME result
// shape the original FastAPI endpoint returned, so DuckDbDataGetter can stand in
// for the HTTP DataGetter without the rest of the app noticing.
//
// See docs/read-only-port-plan.md for the endpoint-by-endpoint mapping.

import { query } from './db';

// Helper: SQL IN-list of integers. Caller guarantees ids are numeric.
const inList = (ids) => (ids.length ? ids.map(Number).join(',') : 'NULL');
// Helper: SQL IN-list of quoted strings, escaping single quotes.
const inStr = (vals) =>
  vals.length ? vals.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',') : "NULL";

// get-all-csets — populate the select list.
// Original: SELECT a subset of all_csets ORDER BY created desc.
export async function getAllCsets() {
  return query(`
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
  `);
}

// get-csets (codeset_ids) — full metadata for selected csets, plus a
// researchers dict per row (ported from get_row_researcher_ids_dict).
export async function getCsets(codesetIds) {
  const rows = await query(
    `SELECT * FROM all_csets WHERE codeset_id IN (${inList(codesetIds)})`,
  );
  for (const row of rows) row.researchers = researcherIdsDict(row);
  return rows;
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

// Researcher columns carried on each all_csets row (see RESEARCHER_COLS in the
// backend). Maps researcher-id → [roles], matching get_row_researcher_ids_dict.
const RESEARCHER_COLS = [
  'codeset_created_by',
  'container_created_by',
  'assigned_informatician',
  'assigned_sme',
  'reviewed_by',
  'n3c_reviewer',
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
