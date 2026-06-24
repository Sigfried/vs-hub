#!/usr/bin/env bash
# ============================================================================
# Load the N3C bundle membership into Postgres from data/bundle_cache.json.
# Runs on Siggie's machine against the restored n3c dump. NOT in any sandbox.
# ============================================================================
# Creates n3c.bundle_membership (bundle_name, tag_name, codeset_id), one row per
# (bundle, codeset_id). Bundles with no codeset_ids get one row with codeset_id
# IS NULL so `SELECT DISTINCT bundle_name` still returns every bundle.
#
# Idempotent: drops and recreates the table each run. Re-run after editing
# bundle_cache.json (e.g. dropping an empty/draft cset).
#
#   PG_CONN='dbname=n3c host=localhost' SCHEMA=n3c ./data/scripts/load_bundles_pg.sh
# ============================================================================
set -euo pipefail

PG_CONN="${PG_CONN:-dbname=n3c host=localhost}"
SCHEMA="${SCHEMA:-n3c}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_JSON="$REPO/data/bundle_cache.json"
TSV="$(mktemp -t bundle_membership.XXXXXX.tsv)"
trap 'rm -f "$TSV"' EXIT

# Flatten the JSON to TSV: bundle_name<TAB>tag_name<TAB>codeset_id. Empty bundles
# emit a single \N (NULL) codeset row. LF line endings (psql text COPY rejects CR).
python3 - "$BUNDLE_JSON" "$TSV" <<'PY'
import json, sys
src, out = sys.argv[1], sys.argv[2]
c = json.load(open(src))['bundles']
NULL = chr(92) + 'N'  # backslash-N == NULL for psql \copy text format
with open(out, 'w', newline='\n') as f:
    for name, b in c.items():
        tag = b.get('tag_name', name)
        ids = b.get('codeset_ids', [])
        if ids:
            for cid in ids:
                f.write(f"{name}\t{tag}\t{cid}\n")
        else:
            f.write(f"{name}\t{tag}\t{NULL}\n")
PY

echo "Loading $(wc -l < "$TSV") rows into $SCHEMA.bundle_membership ..."

psql -X -v ON_ERROR_STOP=1 "$PG_CONN" <<SQL
DROP TABLE IF EXISTS $SCHEMA.bundle_membership;
CREATE TABLE $SCHEMA.bundle_membership (
  bundle_name text NOT NULL,
  tag_name    text,
  codeset_id  bigint            -- NULL for bundles with no codeset_ids
);
COMMENT ON TABLE $SCHEMA.bundle_membership IS
  'N3C bundle -> codeset_id membership, loaded from vs-hub data/bundle_cache.json by data/scripts/load_bundles_pg.sh. One row per (bundle, codeset_id); empty bundles get one row with codeset_id IS NULL.';
\copy $SCHEMA.bundle_membership (bundle_name, tag_name, codeset_id) FROM '$TSV' WITH (FORMAT text, NULL '\N')
CREATE INDEX bundle_membership_codeset_id_idx  ON $SCHEMA.bundle_membership (codeset_id);
CREATE INDEX bundle_membership_bundle_name_idx ON $SCHEMA.bundle_membership (bundle_name);
SQL

psql -X -A -t "$PG_CONN" -c "
SELECT 'bundles: '       || COUNT(DISTINCT bundle_name) FROM $SCHEMA.bundle_membership
UNION ALL SELECT 'codeset_ids: ' || COUNT(DISTINCT codeset_id) FROM $SCHEMA.bundle_membership
UNION ALL SELECT 'rows: '        || COUNT(*)                   FROM $SCHEMA.bundle_membership;"
