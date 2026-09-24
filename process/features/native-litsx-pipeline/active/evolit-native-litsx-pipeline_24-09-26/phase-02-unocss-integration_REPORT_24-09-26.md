---
name: report:evolit-native-litsx-pipeline-phase-02-unocss-integration
description: "Verified neutral @litsx/unocss lifecycle integration"
date: 24-09-26
metadata: { node_type: memory, type: phase-report, feature: native-litsx-pipeline, phase: phase-02 }
---

# Phase 02 Report — Neutral UnoCSS Integration

**Status**: ✅ VERIFIED  
**LitSX commit**: `f6d0860`  
**PR**: https://github.com/litsxdev/litsx/pull/61

`@litsx/unocss` now exports a host-neutral `litsxUnoCss()` descriptor from its root. Each
`create(context)` call owns its generator, config graph and module state. The instance contributes
native compiler plugins, compiled-module materialization, observable dependencies, the component
preflight virtual module, one document stylesheet, invalidation, forgetting and cleanup. The root
entry imports neither Evolit nor Vite; the existing Vite facade remains compatible.

Configuration reload snapshots and rewrites relative ESM imports/exports and static CommonJS
`require()` calls. It supports modification, deletion, creation and recreation of discovered
configs, isolates concurrent instances with unique snapshot identities and removes partial
temporaries when parsing/loading fails. `preflightModule: false` omits both resolution and output.

## Verification

- Independent EVL probes: ESM/CJS config dependency reload, partial-failure cleanup, concurrent
  same-project instances, deletion/recreation and disabled preflight all PASS.
- Focused UnoCSS/type/Vite suite: **92/92 PASS**.
- `yarn release:check`: PASS.
- `yarn release:smoke:scaffolds`: all CSS/Tailwind/UnoCSS matrices PASS.
- `yarn release:test`: **305/305 PASS**, SSR performance thresholds PASS.
- Runtime dependency and forbidden-import checks: PASS.

