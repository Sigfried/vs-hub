# Save-back design (DEFERRED — do not build until read-only works)

Save edited/new csets from the static app so they persist and reload alongside
the seed csets. Captured now so Phase 1 (read-only) is built to make this easy.
**No save-back code is written until the app fully works in read-only mode.**

## Principles

- **Edits create new versions; nothing is ever mutated.** Each save is a new
  immutable file. No clobbering, no concurrency conflicts ("if concurrency is a
  problem, that's a good problem to have"). TermHub's own cset-compare feature is
  the "diff" users care about — git diffs aren't a design concern.
- **No user authentication.** Email/GitHub login would require a server anyway.
- **Static site can't hold a write token** → one tiny serverless function is the
  only component that touches GitHub. Not a backend — a guarded write proxy.

## Storage format — envelope

Top-level TermHub metadata wrapping a verbatim, embedded ATLAS-format
`expression` block:

```jsonc
{
  "termhub_version": 1,
  "codeset_id": 123456789,
  "parent_codeset_id": 123456788,        // version lineage
  "concept_set_name": "...",
  "concept_set_version_title": "...",
  "version": 3,
  "provenance": "...", "intention": "...", "limitations": "...",
  "annotation": "...",
  "authors": { /* original researchers preserved — these csets are their work */ },
  "counts": { "distinct_person_cnt": 0, "total_cnt": 0 },  // N3C counts from backup
  "created_at": "<iso>",
  "expression": { /* verbatim OHDSI/ATLAS items[]: concept + includeDescendants/
                     includeMapped/isExcluded flags */ }
}
```

Why envelope: ATLAS JSON alone has no slot for TermHub metadata; the envelope
keeps the standard (VSAC/ATLAS import = wrap; export = hand back `expression`)
**and** carries metadata. Preserve original authors and reuse N3C counts from
the backup.

## Write path — serverless proxy → GitHub

Client `POST /save-cset` → function commits an immutable versioned file
(`data/user-csets/{codeset_id}_v{n}.json`) to the repo via the GitHub contents
API, then updates a manifest (`data/user-csets/manifest.json`). Platform:
Cloudflare Worker / Netlify / Vercel free tier. The repo write token lives only
in the function's secrets.

**Abuse defense (all in the function, since there's no auth):**
- **Schema validation** — accept only known fields/types, length caps, integer
  `concept_id`s. This is also the injection defense: validate at the write
  boundary, write the file ourselves, never echo raw user bytes into a path or
  commit message. (The frontend treats all loaded text as data; React escapes.)
- **Rate limiting** by IP.
- **Cloudflare Turnstile** (free, no login) on save.
- **Manifest-growth cap** — reject if saves are arriving too fast / too large.

## Reload loop

Saved files are static files in the repo. DuckDB-Wasm loads seed Parquet + the
`user-csets/` files (listed by the manifest) together on boot — they're just
more files over HTTP from the same origin. On save, also optimistically insert
the new cset into the in-browser DuckDB immediately, because a GitHub commit +
Pages rebuild takes seconds–minutes to become visible.

**Build Phase 1 to make this easy:** have the loader read a manifest of cset
files (not a hardcoded list), and keep the in-browser cset store appendable, so
adding user csets later is "load more files" rather than a rearchitecture.

## Future (not now)

Import value sets from VSAC / [ATLAS](https://atlas-demo.ohdsi.org/) — both have
public APIs. Client-side fetch → wrap in envelope → load into local DuckDB.
