---
name: plan:evolit-native-litsx-pipeline-phase-02-unocss-integration
description: "Phase 2: neutral single-declaration integration in @litsx/unocss"
date: 24-09-26
metadata: { node_type: memory, type: phase-plan, feature: native-litsx-pipeline, phase: phase-02 }
---

# Phase 02 — Neutral `@litsx/unocss` Integration

**Date**: 24-09-26  
**Complexity**: COMPLEX  
**Status**: ✅ VERIFIED

## Context and Goals

This phase adapts the existing integration package to the generic protocol. Read the LitSX repository context plus Evolit's `process/context/all-context.md` and testing context; post-phase testing includes existing UnoCSS and Vite regressions.

## Phase Completion Rules

The phase reaches ✅ VERIFIED only after neutral factory behavior, legacy facade compatibility, failure handling, exact package gates and the user's standing autopilot confirmation are recorded.

## Purpose

Expose one build-tool-neutral factory from the existing package that encapsulates compiler plugins, engine creation, config loading, outputs, finalization, invalidation and cleanup.

## Entry Gate

- Phase 1 protocol and contract tests green.

## Blast Radius

- LitSX `packages/unocss` public exports/types, engine/config resolution, tests, docs and changeset.

## Implementation Checklist

- [ ] Implement a neutral factory matching the generic protocol without importing Evolit.
- [ ] Own Uno configuration discovery, compiler contributions and one engine per instance.
- [ ] Map materialization, dependencies, preflight/global outputs, finalize, invalidate/forget and cleanup.
- [ ] Preserve the Vite facade by composing the same neutral primitives.
- [ ] Add package tests, documentation and release intent.

## Acceptance Criteria

- [ ] One neutral declaration encapsulates all compiler/build lifecycle responsibilities.
- [ ] No Evolit import or adapter entrypoint exists in `@litsx/unocss`.
- [ ] Existing Vite consumers remain compatible.

## Exit Gate

```bash
yarn test
yarn typecheck
```

## Blockers That Would Justify BLOCKED Status

- Package policy forbids a neutral export or the engine lacks required invalidation primitives.

## Phase Loop Progress

- [ ] 1. RESEARCH
- [ ] 2. INNOVATE
- [ ] 3. PLAN-SUPPLEMENT
- [ ] 4. PVL
- [ ] 5. EXECUTE
- [ ] 6. EVL
- [ ] 7. UPDATE-PROCESS

## Touchpoints

- Existing `@litsx/unocss` package only; no Evolit adapter entrypoint.

## Public Contracts

- Neutral combined integration factory exported from `@litsx/unocss`.

## Verification Evidence

| Gate / Scenario | Strategy | Evidence class | Proves SPEC criterion |
|---|---|---|---|
| Neutral factory suite | Fully-Automated | product-behavior | AC3 |
| Existing UnoCSS/Vite regressions | Fully-Automated | integration-runtime | AC4–AC7 |

## Test Infra Improvement Notes

(none identified yet)

## Resume and Execution Handoff

- Execute anchor: this file. Supporting files: umbrella, SPEC and Phase 1 report.
- Selected plan: this file; wait for Phase 1.
- Next instruction: run fresh LitSX research and PVL before executing.

## Validate Contract

(placeholder — vc-validate-agent writes this section before EXECUTE)

## Next Instruction

After Phase 1, run fresh repository research and PVL before execution.
