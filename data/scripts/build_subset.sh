#!/usr/bin/env bash
# ============================================================================
# Build the TermHub demo Parquet subset from the N3C dump.
# Runs on Siggie's machine (needs DuckDB + the 32 GB dump). NOT in any sandbox.
# ============================================================================
set -euo pipefail

# --- config -----------------------------------------------------------------
# Path where the restored data lives. Two supported modes:
#   MODE=pg      -> read from a local Postgres via DuckDB's postgres scanner
#   MODE=duckdb  -> tables already imported into a local DuckDB file
MODE="${MODE:-pg}"

# For MODE=pg: a libpq connection string to the restored dump.
PG_CONN="${PG_CONN:-dbname=n3c host=localhost}"
# Schema the TermHub/OMOP tables live in inside Postgres (often 'n3c' or 'public').
SCHEMA="${SCHEMA:-n3c}"

# For MODE=duckdb: path to the DuckDB file holding the imported tables.
DUCKDB_FILE="${DUCKDB_FILE:-data/duckdb/n3c.duckdb}"

# Max versions kept per value set (earliest + latest + evenly-spaced middles).
# Override: MAX_VERSIONS=2 ./build_subset.sh
MAX_VERSIONS="${MAX_VERSIONS:-3}"

# Descendant-expansion depth for the concept universe.
#   0 = full transitive closure (all descendants); N = down to N levels.
# Start at 0 to measure; if the bundle explodes, re-run with e.g. MAX_DEPTH=3.
MAX_DEPTH="${MAX_DEPTH:-0}"

# Vocabs to EXCLUDE from descendant expansion (cset members in these vocabs are
# still kept; only their descendant trees are dropped). Comma-separated, no
# quotes here — the script quotes them. Default hides RxNorm Extension (US-only
# data; TermHub hides it by default). Set HIDE_VOCABS="" to disable.
HIDE_VOCABS="${HIDE_VOCABS:-RxNorm Extension}"

# Vocabs to COMPLETE: pull in ALL used (total_cnt>0) concepts of these vocabs so
# authors can browse/search them, not just the cset-reached slice. Comma-
# separated. Default = labs (LOINC), oncology (ICDO3, HemOnc), procedures
# (ICD10PCS), plus the used-but-missing standard backbone (SNOMED, RxNorm).
# Set COMPLETE_VOCABS="" to disable.
COMPLETE_VOCABS="${COMPLETE_VOCABS:-LOINC,ICDO3,HemOnc,ICD10PCS,SNOMED,RxNorm}"

# Output dir for the demo Parquet (committed for GitHub Pages).
OUT="${OUT:-data/public}"

# --- locate ourselves -------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SQL_TEMPLATE="$REPO/data/sql/extract_subset.sql"
BUNDLE_JSON="$REPO/data/bundle_cache.json"
OUT_ABS="$REPO/$OUT"
mkdir -p "$OUT_ABS"

# --- build the SRC table-reference prefix + ATTACH preamble -----------------
if [[ "$MODE" == "pg" ]]; then
  PREAMBLE="INSTALL postgres; LOAD postgres; ATTACH '$PG_CONN' AS pg (TYPE postgres, READ_ONLY);"
  SRC="pg.$SCHEMA."
elif [[ "$MODE" == "duckdb" ]]; then
  PREAMBLE="ATTACH '$REPO/$DUCKDB_FILE' AS src (READ_ONLY);"
  SRC="src.$SCHEMA."   # set SCHEMA='' if tables are top-level in the duckdb file
else
  echo "Unknown MODE=$MODE (use 'pg' or 'duckdb')" >&2; exit 1
fi

# Turn a comma-separated vocab list (arg) into a SQL quoted list, trimming and
# escaping each item. Empty -> '' (matches no real vocab, i.e. disables the IN).
vocab_list_sql() {
  local IFS=','; local out=""
  for v in $1; do
    v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"  # trim
    v="${v//\'/\'\'}"                                               # escape '
    out+="${out:+, }'$v'"
  done
  echo "${out:-''}"
}
HIDE_VOCABS_SQL="$(vocab_list_sql "$HIDE_VOCABS")"
COMPLETE_VOCABS_SQL="$(vocab_list_sql "$COMPLETE_VOCABS")"

# --- substitute placeholders & run ------------------------------------------
SQL="$(sed \
  -e "s|{{SRC}}|$SRC|g" \
  -e "s|{{OUT}}|$OUT_ABS|g" \
  -e "s|{{BUNDLE_JSON}}|$BUNDLE_JSON|g" \
  -e "s|{{MAX_VERSIONS}}|$MAX_VERSIONS|g" \
  -e "s|{{MAX_DEPTH}}|$MAX_DEPTH|g" \
  -e "s|{{HIDE_VOCABS}}|$HIDE_VOCABS_SQL|g" \
  -e "s|{{COMPLETE_VOCABS}}|$COMPLETE_VOCABS_SQL|g" \
  "$SQL_TEMPLATE")"

echo "== TermHub subset build =="
echo "  MODE=$MODE  MAX_VERSIONS=$MAX_VERSIONS  MAX_DEPTH=$MAX_DEPTH"
echo "  HIDE_VOCABS=[$HIDE_VOCABS] -> $HIDE_VOCABS_SQL"
echo "  COMPLETE_VOCABS=[$COMPLETE_VOCABS] -> $COMPLETE_VOCABS_SQL"
echo "  SRC=$SRC"
echo "  BUNDLE_JSON=$BUNDLE_JSON"
echo "  OUT=$OUT_ABS"
echo

duckdb -c "$PREAMBLE $SQL"

echo
echo "== resulting parquet files =="
/bin/ls -lh "$OUT_ABS"/*.parquet
echo
echo "== total bundle size (aim ≲ a few hundred MB) =="
du -ch "$OUT_ABS"/*.parquet | tail -1
