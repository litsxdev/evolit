# Phase 01 Report — Generic Evolit LitSX Pipeline

Status: ✅ VERIFIED on 24-09-26.

Implemented a typed `litsx: { compiler, integrations }` surface through
`evolit/litsx`, with an isolated descriptor factory lifecycle per server,
build, or runtime. Compiler plugins compose in declaration order while Evolit
retains `filename`, `ssr`, source-map policy, native lowering, and
`reactCompat: false`.

The lifecycle now covers compiled-module processing, neutral virtual-module
resolution, canonical dependencies, generated assets/modules/styles,
graph finalization, incremental generations, invalidation, cascading forget,
and idempotent cleanup. Output publication is staged and committed as one
generation with rollback. Document styles are content-versioned, served by
the normal asset origin, recorded in manifests, and linked once in SSR.

Security and isolation evidence includes safe integration names and output
IDs, path/traversal/URL/HTML rejection, physical collision detection, opaque
pipeline cache identity, contextual errors with preserved causes, production
HTTP redaction, reverse cleanup, stale-dependency replacement, and atomic
multi-integration failure recovery.

Verification:

- Generic lifecycle and public type suite: 8/8 pass.
- Independent EVL probes for generations, dependencies, forget, collisions,
  and rollback: pass.
- `yarn workspace evolit typecheck`: pass.
- `git diff --check`: pass.
- Full Evolit package suite with localhost access: 205/205 pass.

The real external dependency watcher and browser behavior remain program-level
proofs in Phase 3, where `uno.config` and the direct UnoCSS fixture exercise the
same generic hooks end to end.
