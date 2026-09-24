---
name: report:evolit-native-litsx-pipeline-phase-03-shadow-runtime-verification
description: "Verified direct UnoCSS Shadow DOM behavior across Evolit runtimes"
date: 24-09-26
metadata: { node_type: memory, type: phase-report, feature: native-litsx-pipeline, phase: phase-03 }
---

# Phase 03 Report — Shadow DOM and Runtime Verification

**Status**: ✅ VERIFIED  
**Evolit commit**: `b166e5c`

The direct fixture configures `@litsx/unocss` once from `evolit.config.js` and contains two native
Shadow DOM components. It covers shared/exclusive utilities, finite local and imported class maps,
explicit guards, arbitrary values, data/ARIA/dark variants, inherited theme variables, authored
style ordering, Declarative Shadow DOM and browser hydration.

Development verification adds and removes a component utility, reloads `uno.config`, replaces the
content-hashed global link and proves stale CSS is not retained. Production verification exercises
build and standalone runtime, prevents filesystem paths in prerendered preloads, checks one document
theme asset, repeats a build deterministically and runs two projects concurrently with distinct
themes to prove state isolation.

## Verification

- Generic lifecycle tests: **8/8 PASS**.
- Direct UnoCSS Node integration: **3/3 PASS**.
- Complete Evolit Node suite outside the network sandbox: **208/208 PASS**.
- Complete Chromium suite: **11/11 PASS**.
- Typecheck: PASS.
- Regression coverage includes routing, SSR, hydration, sourcemaps, client assets, cache and
  optional `@litsx/urql`, including applications without `litsx` configuration.

