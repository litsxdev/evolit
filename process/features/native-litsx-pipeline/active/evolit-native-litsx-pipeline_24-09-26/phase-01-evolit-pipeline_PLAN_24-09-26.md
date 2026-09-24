---
name: plan:evolit-native-litsx-pipeline-phase-01-evolit-pipeline
description: "Phase 1: generic typed LitSX pipeline lifecycle in Evolit"
date: 24-09-26
metadata: { node_type: memory, type: phase-plan, feature: native-litsx-pipeline, phase: phase-01 }
---

# Phase 01 — Generic Evolit LitSX Pipeline

**Date**: 24-09-26  
**Complexity**: COMPLEX  
**Status**: ✅ VERIFIED  
**Report:** `phase-01-evolit-pipeline_REPORT_24-09-26.md`

## Context and Goals

This is the generic foundation phase. Read `process/context/all-context.md` and the external `process/context/tests/all-tests.md` mirror before execution; post-phase testing must prove generic behavior and no-config regressions.

## Phase Completion Rules

The phase reaches ✅ VERIFIED only after integration tests, failure behavior, state isolation, full phase gates and the user's standing autopilot confirmation are recorded. Code or typecheck alone is not completion.

## Purpose

Add the public typed configuration and a generic isolated lifecycle used by every Evolit compilation/runtime path, proved by a non-UnoCSS test integration.

## Entry Gate

- Program SPEC and Decision Summary exist; baseline behavior is recorded.

## Blast Radius

- `packages/evolit/src/config.js`, `compiler.js`, `client-assets.js`, `build.js`, `deployment-runtime.js`, `server.js`, `render.js`, `server-setup.js`, `ssr-adapter.js`, `index.js`; package metadata, declarations/helper and tests.

## Implementation Checklist

- [x] Define public configuration/integration types and normalization/error context.
- [x] Create one isolated pipeline/session per server, build or runtime.
- [x] Lock `litsx: { compiler, integrations }`: stateless descriptors with unique `name` and `create(context)`; instances may contribute compiler options and `processModule`, `resolveModule`, `finalize`, `invalidate`, `forget`, `dispose` hooks.
- [x] Merge app options then integration options in declaration order; concatenate plugin arrays; force target `filename`/`ssr`, required source maps/native lowering and `reactCompat: false`.
- [x] Process compiled modules before classification/rewrite; register canonical dependency paths and owned outputs.
- [x] Validate output IDs/kinds/content, reject absolute/traversal/URL/raw-HTML/collisions, materialize only below integration-owned `.evolit` roots, and merge additive manifest/document-style entries.
- [x] Give every pipeline an opaque cache identity; route compile, inventory, route render, static params and server setup through the same instance.
- [x] Finalize exactly once per complete production graph or serialized development generation; stage outputs/manifests atomically and retire stale ownership only after publish.
- [x] Dynamically watch canonical declared dependencies, ignore generated roots, then invalidate integration → compiler/inventory caches → stale ownership → rebuild/finalize → one notification.
- [x] Use failure-safe idempotent reverse-order cleanup and contextual internal errors with production HTTP redaction.
- [x] Add a fake integration covering types, option order/invariants, outputs, collisions/traversal, virtual imports, invalidation/forget, exact-once finalize, failure cleanup and concurrent isolation.

## Acceptance Criteria

- [x] Application compiler options and integration contributions compose without overriding framework invariants.
- [x] Lifecycle outputs, invalidation, stale removal and cleanup are generic and isolated.
- [x] Applications without `litsx` retain existing behavior.

## Exit Gate

```bash
node --test packages/evolit/test/litsx-pipeline.test.js packages/evolit/test/litsx-pipeline-types.test.js
node --test packages/evolit/test/compiler.test.js packages/evolit/test/client-assets.test.js packages/evolit/test/deployment-runtime.test.js packages/evolit/test/server-setup.test.js
yarn workspace evolit typecheck
yarn workspace evolit test
```

## Blockers That Would Justify BLOCKED Status

- Generic output ownership cannot be represented without integration-specific behavior.

## Phase Loop Progress

- [x] 1. RESEARCH
- [x] 2. INNOVATE
- [x] 3. PLAN-SUPPLEMENT
- [x] 4. PVL
- [x] 5. EXECUTE
- [x] 6. EVL
- [x] 7. UPDATE-PROCESS

## Touchpoints

- Config loading, compiler graphs, invalidation/cleanup and asset manifests.

## Public Contracts

- Typed `litsx` configuration and generic integration factory/lifecycle context.

## Verification Evidence

| Gate / Scenario | Strategy | Evidence class | Proves SPEC criterion |
|---|---|---|---|
| Generic lifecycle suite | Fully-Automated | product-behavior | AC1, AC2 |
| Existing package tests/typecheck | Fully-Automated | integration-runtime | AC9 |

## Test Infra Improvement Notes

(none identified yet)

## Resume and Execution Handoff

- Execute anchor: this file. Supporting files: umbrella plan and program SPEC in the same folder.
- Selected plan: this file; research/innovate/plan complete; validate contract pending.
- Next instruction: run PVL, replace the placeholder contract, then execute this phase only.

## Validate Contract

Status: VALIDATED  
Gate: CONDITIONAL — 0 FAIL / 13 CONCERN / 0 PASS; all concerns converted into plan steps or execute instructions.

### Plan updates applied

- Expanded real call-site/package/type/head-link blast radius.
- Locked descriptor/instance boundary, compiler merge order and native invariants.
- Defined session-aware caches, graph generations, safe output ownership, dynamic dependencies, invalidation order, cleanup and error policy.
- Added type-consumer, same-project isolation, collision/path, exact-once finalize, failure cleanup and no-config scenarios.

### Execute-agent instructions

1. Treat integrations as trusted code but validate every declaration; do not claim sandboxing.
2. Keep the no-`litsx` fast path behavior-compatible and all existing compiler exports optional-call compatible.
3. Never mutate config descriptors or accept raw filesystem paths, URLs or HTML from outputs.
4. Apply integration processing before server/client classification and import rewriting; inventory must use identical contributions.
5. Publish outputs and manifests as one generation; never expose partial state.
6. Preserve original hook errors as `cause`, attach integration/phase/mode/target/module/output context, and redact production HTTP bodies.
7. Dispose partial initialization and repeated close/dispose safely while preserving the primary error.
8. Run localhost-dependent suite outside the restricted sandbox if `listen EPERM` occurs.

### Test gates

- Fully automated: focused LitSX pipeline/type suites; existing compiler/assets/runtime/setup suites; typecheck.
- Hybrid: full package suite with localhost binding; real watcher dependency invalidation.
- Agent-probe: inspect one generated manifest/output generation after stale removal.
- Known gap deferred to Phase 4: installation from the published registry.

### High-risk pack

Required for output containment, cache/session isolation and cleanup evidence; automated security cases satisfy it for Phase 1.

### Backlog artifacts

- Exact-lockfile dependency advisory remediation is a Phase 4 release gate, not a Phase 1 blocker.

### Known gaps

- Abrupt process-kill crash recovery and multi-browser coverage are outside Phase 1; normal failure atomicity and Chromium remain required.

Accepted by: autopilot standing consent, 24-09-26.

## Next Instruction

Proceed to Phase 2 validation and the neutral `@litsx/unocss` factory.
