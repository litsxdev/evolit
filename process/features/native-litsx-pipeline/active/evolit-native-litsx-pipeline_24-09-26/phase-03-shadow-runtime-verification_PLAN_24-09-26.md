---
name: plan:evolit-native-litsx-pipeline-phase-03-shadow-runtime-verification
description: "Phase 3: direct UnoCSS fixture and runtime/Shadow DOM verification"
date: 24-09-26
metadata: { node_type: memory, type: phase-plan, feature: native-litsx-pipeline, phase: phase-03 }
---

# Phase 03 — Shadow DOM and Runtime Verification

**Date**: 24-09-26  
**Complexity**: COMPLEX  
**Status**: ✅ VERIFIED

## Context and Goals

This phase proves the consumer-visible behavior. Read `process/context/all-context.md`, `process/context/tests/all-tests.md`, and prior reports; post-phase testing is the full Node/browser/build regression matrix.

## Phase Completion Rules

The phase reaches ✅ VERIFIED only when SSR, hydration, development invalidation, production, standalone and prior regressions are green with inspectable evidence and the user's standing autopilot confirmation.

## Purpose

Build the direct fixture and prove development invalidation, SSR, hydration, production, standalone, deterministic assets and regressions.

## Entry Gate

- Phases 1 and 2 APIs are green and installable together locally.

## Blast Radius

- Evolit fixtures/tests, Playwright suite, assets/SSR linking, dev dependencies and lockfile.

## Implementation Checklist

- [x] Add a direct integration fixture with two native Shadow DOM components and every required candidate form.
- [x] Assert utility/preflight ownership, authored-style ordering, DSD markup and hydrated equivalence.
- [x] Assert one global theme/custom-property asset and inheritance into shadow roots.
- [x] Test add/remove class, config change, stale removal and deduplication in development.
- [x] Test repeated/concurrent builds, standalone serving, asset links and project isolation.
- [x] Run routing, SSR, hydration, source-map, asset, cache and URQL regressions.

## Acceptance Criteria

- [x] Required utility forms and preflight are owned by the correct Shadow DOM component.
- [x] Global theme output appears once and hydrates without drift.
- [x] Development removes stale CSS and production/concurrent builds remain isolated.

## Exit Gate

```bash
yarn test
yarn typecheck
yarn build
yarn test:browser
```

## Blockers That Would Justify BLOCKED Status

- Browser cannot observe required Shadow DOM state or a compatible upstream package cannot be installed.

## Phase Loop Progress

- [ ] 1. RESEARCH
- [ ] 2. INNOVATE
- [ ] 3. PLAN-SUPPLEMENT
- [ ] 4. PVL
- [ ] 5. EXECUTE
- [ ] 6. EVL
- [ ] 7. UPDATE-PROCESS

## Touchpoints

- Development, SSR, browser hydration, build and start runtime tests.

## Public Contracts

- Exact consumer configuration and component/document asset behavior.

## Verification Evidence

| Gate / Scenario | Strategy | Evidence class | Proves SPEC criterion |
|---|---|---|---|
| Direct integration Node suites | Fully-Automated | integration-runtime | AC3–AC8 |
| Chromium SSR/hydration/HMR | Fully-Automated | product-behavior | AC4–AC7 |
| Existing full regression matrix | Fully-Automated | integration-runtime | AC9 |

## Test Infra Improvement Notes

(none identified yet)

## Resume and Execution Handoff

- Execute anchor: this file. Supporting files: umbrella, SPEC, Phase 1 and Phase 2 reports.
- Selected plan: this file; wait for Phase 2.
- Next instruction: research installed versions, run PVL, then execute the fixture matrix.

## Validate Contract

(placeholder — vc-validate-agent writes this section before EXECUTE)

## Next Instruction

After Phase 2, research installed versions and run PVL before executing the fixture matrix.
