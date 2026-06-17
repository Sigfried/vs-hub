-- ============================================================================
-- TermHub demo — subset extraction → Parquet
-- ============================================================================
-- Produces the small Parquet bundle that DuckDB-Wasm loads in the browser.
--
-- DRIVER = the N3C "bundles" (N3C Recommended, drug classes, COVID, etc.) from
-- data/bundle_cache.json, EXPANDED to include version history of each value set,
-- then CAPPED to at most 3 versions per value set (the latest, the earliest, and
-- one evenly-spaced middle) to keep the version UI uncluttered.
--
-- KEY INSIGHT: the dump already contains the derived tables materialized
-- (all_csets, cset_members_items, concepts_with_counts). We FILTER them to the
-- chosen codeset_ids — we do NOT re-run the original DDL. This preserves the N3C
-- counts and the original researcher/author names automatically.
--
-- Measured sizes (see docs): bundle-only ~63 MB; bundle + capped versions is
-- smaller still than the uncapped ~125 MB. Comfortably within browser budget.
--
-- Placeholders {{SRC}} (table-ref prefix), {{OUT}} (output dir),
-- {{BUNDLE_JSON}} (path to bundle_cache.json) are substituted by build_subset.sh.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0a. Bundle codeset_ids — flatten data/bundle_cache.json
--     Shape: { "bundles": { "<name>": { "codeset_ids": [..] }, ... } }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE bundle_ids AS
WITH raw AS (
  SELECT unnest(json_keys(bundles)) AS bundle_name, bundles
  FROM read_json_auto('{{BUNDLE_JSON}}')
)
SELECT DISTINCT
  CAST(cid AS BIGINT) AS codeset_id,
  bundle_name
FROM raw,
     UNNEST(CAST(json_extract(bundles, '$."' || bundle_name || '".codeset_ids') AS BIGINT[])) AS t(cid);

-- ---------------------------------------------------------------------------
-- 0b. Expand to version history: every cset sharing a concept_set_name with a
--     bundle cset. Drop 0-member drafts (no rows in cset_members_items).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE bundle_names AS
SELECT DISTINCT ac.concept_set_name
FROM {{SRC}}all_csets ac
JOIN bundle_ids b ON ac.codeset_id = b.codeset_id;

CREATE OR REPLACE TEMP TABLE versioned AS
SELECT ac.codeset_id,
       ac.concept_set_name,
       ac.codeset_created_at,
       ac.version
FROM {{SRC}}all_csets ac
JOIN bundle_names bn ON ac.concept_set_name = bn.concept_set_name
WHERE EXISTS (                       -- has at least one member/item (not a 0-member draft)
  SELECT 1 FROM {{SRC}}cset_members_items m WHERE m.codeset_id = ac.codeset_id
);

-- ---------------------------------------------------------------------------
-- 0c. Version cap: keep at most {{MAX_VERSIONS}} (default 3) per value set —
--     always the earliest and latest (lineage endpoints), plus evenly-spaced
--     middles. Order chronologically by codeset_created_at (fully populated;
--     `version` is null for ~40% of csets so it can't be the sort key).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE ranked AS
SELECT *,
       ROW_NUMBER() OVER (PARTITION BY concept_set_name ORDER BY codeset_created_at)        AS rn_asc,
       COUNT(*)     OVER (PARTITION BY concept_set_name)                                    AS n_ver
FROM versioned;

CREATE OR REPLACE TEMP TABLE demo_codesets AS
SELECT codeset_id
FROM ranked
WHERE n_ver <= {{MAX_VERSIONS}}                    -- keep all if within cap
   OR rn_asc = 1                                    -- earliest (anchor)
   OR rn_asc = n_ver                                -- latest (anchor)
   -- evenly-spaced interior picks filling the remaining (MAX_VERSIONS-2) slots:
   OR rn_asc IN (
        SELECT CAST(round(k * (n_ver - 1.0) / ({{MAX_VERSIONS}} - 1)) AS BIGINT) + 1
        FROM range(1, {{MAX_VERSIONS}} - 1) AS g(k)
      );

-- ---------------------------------------------------------------------------
-- 1. csets metadata  → all_csets.parquet  (drives select list + cards)
--    Carries N3C counts + container_creator/codeset_creator (original authors).
--    Drop atlas_json — large and not needed for the read-only views.
-- ---------------------------------------------------------------------------
COPY (
  SELECT * EXCLUDE (atlas_json)
  FROM {{SRC}}all_csets
  WHERE codeset_id IN (SELECT codeset_id FROM demo_codesets)
) TO '{{OUT}}/all_csets.parquet' (FORMAT parquet);

-- ---------------------------------------------------------------------------
-- 2. members + items → cset_members_items.parquet  (the comparison grid)
-- ---------------------------------------------------------------------------
COPY (
  SELECT *
  FROM {{SRC}}cset_members_items
  WHERE codeset_id IN (SELECT codeset_id FROM demo_codesets)
) TO '{{OUT}}/cset_members_items.parquet' (FORMAT parquet);

-- Seed set: every concept referenced as a member/item of a kept cset.
CREATE OR REPLACE TEMP TABLE seed_concepts AS
SELECT DISTINCT concept_id
FROM {{SRC}}cset_members_items
WHERE codeset_id IN (SELECT codeset_id FROM demo_codesets);

-- ---------------------------------------------------------------------------
-- 2b. CONCEPT UNIVERSE = seed concepts + their DESCENDANTS.
--     TermHub deliberately surfaces each cset concept's descendants so users
--     can see and add them while authoring (the original concept-graph endpoint
--     pulled successors). We expand via concept_ancestor.
--
--     {{MAX_DEPTH}} controls expansion (substituted by build_subset.sh):
--       0  = FULL transitive closure (all descendants, any depth)
--       N  = descendants down to N levels (min_levels_of_separation <= N)
--     WARNING: depth 0 over high-level concepts can explode (concept_ancestor
--     is the bulk of the 30 GB dump). Measure with the report below; if too big
--     re-run with a bounded MAX_DEPTH.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE concept_universe AS
SELECT concept_id FROM seed_concepts
UNION
SELECT DISTINCT ca.descendant_concept_id
FROM {{SRC}}concept_ancestor ca
WHERE ca.ancestor_concept_id IN (SELECT concept_id FROM seed_concepts)
  AND ({{MAX_DEPTH}} = 0 OR ca.min_levels_of_separation <= {{MAX_DEPTH}});

-- ---------------------------------------------------------------------------
-- 3. concepts + counts → concepts_with_counts.parquet  (concept metadata)
--    Over the FULL universe (seed + descendants), so the authoring/hierarchy
--    views can show descendant concepts not directly in any cset.
-- ---------------------------------------------------------------------------
COPY (
  SELECT *
  FROM {{SRC}}concepts_with_counts
  WHERE concept_id IN (SELECT concept_id FROM concept_universe)
) TO '{{OUT}}/concepts_with_counts.parquet' (FORMAT parquet);

-- ---------------------------------------------------------------------------
-- 4. graph edges → concept_graph.parquet  (the hierarchy; replaces the pickle)
--    concept_graph = concept_ancestor WHERE min_levels_of_separation = 1
--    (direct parent→child edges). Both endpoints within the universe.
-- ---------------------------------------------------------------------------
COPY (
  SELECT ancestor_concept_id   AS source_id,
         descendant_concept_id AS target_id
  FROM {{SRC}}concept_ancestor
  WHERE min_levels_of_separation = 1
    AND ancestor_concept_id   IN (SELECT concept_id FROM concept_universe)
    AND descendant_concept_id IN (SELECT concept_id FROM concept_universe)
) TO '{{OUT}}/concept_graph.parquet' (FORMAT parquet);

-- ---------------------------------------------------------------------------
-- 5. tiny lookups → export whole.
-- ---------------------------------------------------------------------------
COPY (SELECT * FROM {{SRC}}vocabulary)   TO '{{OUT}}/vocabulary.parquet'   (FORMAT parquet);
COPY (SELECT * FROM {{SRC}}domain)       TO '{{OUT}}/domain.parquet'       (FORMAT parquet);
COPY (SELECT * FROM {{SRC}}relationship) TO '{{OUT}}/relationship.parquet' (FORMAT parquet);

-- ---------------------------------------------------------------------------
-- 6. sanity report — watch 'concepts_universe' vs 'concepts_seed' to see how
--    much the descendant expansion adds at the chosen MAX_DEPTH.
-- ---------------------------------------------------------------------------
SELECT 'max_depth (0=full)'      AS metric, {{MAX_DEPTH}}                          AS n
UNION ALL SELECT 'bundle_csets_pre_version', (SELECT COUNT(*) FROM bundle_ids)
UNION ALL SELECT 'value_sets',               (SELECT COUNT(*) FROM bundle_names)
UNION ALL SELECT 'csets_kept',               (SELECT COUNT(*) FROM demo_codesets)
UNION ALL SELECT 'member_rows',              (SELECT COUNT(*) FROM {{SRC}}cset_members_items WHERE codeset_id IN (SELECT codeset_id FROM demo_codesets))
UNION ALL SELECT 'concepts_seed',            (SELECT COUNT(*) FROM seed_concepts)
UNION ALL SELECT 'concepts_universe',        (SELECT COUNT(*) FROM concept_universe)
UNION ALL SELECT 'graph_edges',              (SELECT COUNT(*) FROM {{SRC}}concept_ancestor
                                               WHERE min_levels_of_separation = 1
                                                 AND ancestor_concept_id   IN (SELECT concept_id FROM concept_universe)
                                                 AND descendant_concept_id IN (SELECT concept_id FROM concept_universe));
