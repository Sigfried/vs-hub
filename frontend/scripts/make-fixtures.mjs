// Generate a tiny synthetic Parquet bundle so the frontend / DuckDB layer can be
// developed and smoke-tested before the real extraction (data/public/*.parquet)
// exists. Schemas mirror the real tables (subset of columns the demo uses).
//
// Usage:  node frontend/scripts/make-fixtures.mjs [outDir]
//   default outDir: frontend/src/fixtures/parquet
//
// Requires DuckDB CLI on PATH (brew install duckdb) — used purely as the Parquet
// writer. No dependency on the 30 GB dump.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] || resolve(here, '../src/fixtures/parquet'));
mkdirSync(outDir, { recursive: true });

// Two small overlapping csets + a 3-level hierarchy, enough to exercise the
// select list, comparison grid, search, and graph views.
const sql = `
COPY (SELECT * FROM (VALUES
  (1001, 'Statins v1',  'Statins',  '2021-01-01T00:00', 1.0, '{"Members":3}', 120, 4500),
  (1002, 'Statins v2',  'Statins',  '2022-06-01T00:00', 2.0, '{"Members":4}', 150, 5200),
  (2001, 'Diabetes v1', 'Diabetes', '2021-03-01T00:00', 1.0, '{"Members":3}', 300, 9000)
) t(codeset_id, concept_set_version_title, alias, codeset_created_at, version, counts, distinct_person_cnt, total_cnt))
TO '${outDir}/all_csets.parquet' (FORMAT parquet);

-- NOTE: real csets typically include higher-level concepts; the graph endpoint
-- pulls their DESCENDANTS to build the tree (it does NOT add ancestors). So
-- cset 1001 includes the class concept 40000, whose children are the statins.
COPY (SELECT *, true AS csm, true AS item, 'S' AS standard_concept FROM (VALUES
  (1001, 40000, 'RxNorm', 'HMG CoA reductase inhibitor'),
  (1001, 40001, 'RxNorm', 'Atorvastatin'),
  (1001, 40002, 'RxNorm', 'Simvastatin'),
  (1002, 40000, 'RxNorm', 'HMG CoA reductase inhibitor'),
  (1002, 40002, 'RxNorm', 'Simvastatin'),
  (1002, 40004, 'RxNorm', 'Pravastatin'),
  (2001, 50000, 'SNOMED', 'Diabetes mellitus'),
  (2001, 50001, 'SNOMED', 'Type 2 diabetes'),
  (2001, 40000, 'RxNorm', 'HMG CoA reductase inhibitor')
) t(codeset_id, concept_id, vocabulary_id, concept_name))
TO '${outDir}/cset_members_items.parquet' (FORMAT parquet);

COPY (SELECT *, 'S' AS standard_concept, 0 AS distinct_person_cnt FROM (VALUES
  (40001, 'Atorvastatin',     'Drug',      'RxNorm', 'Ingredient', 4500),
  (40002, 'Simvastatin',      'Drug',      'RxNorm', 'Ingredient', 3200),
  (40003, 'Rosuvastatin',     'Drug',      'RxNorm', 'Ingredient', 2100),
  (40004, 'Pravastatin',      'Drug',      'RxNorm', 'Ingredient', 1800),
  (40000, 'HMG CoA reductase inhibitor', 'Drug', 'RxNorm', 'Class', 9000),
  (50001, 'Type 2 diabetes',  'Condition', 'SNOMED', 'Clinical', 9000),
  (50002, 'Type 1 diabetes',  'Condition', 'SNOMED', 'Clinical', 1200),
  (50000, 'Diabetes mellitus','Condition', 'SNOMED', 'Clinical', 11000)
) t(concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, total_cnt))
TO '${outDir}/concepts_with_counts.parquet' (FORMAT parquet);

-- direct parent->child edges (min_levels_of_separation = 1)
COPY (SELECT * FROM (VALUES
  (40000, 40001), (40000, 40002), (40000, 40003), (40000, 40004),
  (50000, 50001), (50000, 50002)
) t(source_id, target_id))
TO '${outDir}/concept_graph.parquet' (FORMAT parquet);

COPY (SELECT * FROM (VALUES
  ('RxNorm','RxNorm','','v1',0), ('SNOMED','SNOMED','','v1',0)
) t(vocabulary_id, vocabulary_name, vocabulary_reference, vocabulary_version, vocabulary_concept_id))
TO '${outDir}/vocabulary.parquet' (FORMAT parquet);

COPY (SELECT * FROM (VALUES ('Drug','Drug',0),('Condition','Condition',0)) t(domain_id, domain_name, domain_concept_id))
TO '${outDir}/domain.parquet' (FORMAT parquet);

COPY (SELECT * FROM (VALUES ('Subsumes','Subsumes',1,1,'Is a',0)) t(relationship_id, relationship_name, is_hierarchical, defines_ancestry, reverse_relationship_id, relationship_concept_id))
TO '${outDir}/relationship.parquet' (FORMAT parquet);
`;

execFileSync('duckdb', ['-c', sql], { stdio: 'inherit' });
console.log(`\nFixtures written to ${outDir}`);
