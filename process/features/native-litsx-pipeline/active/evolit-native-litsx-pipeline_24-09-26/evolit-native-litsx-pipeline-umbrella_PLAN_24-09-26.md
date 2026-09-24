---
name: plan:evolit-native-litsx-pipeline-umbrella
description: "Umbrella plan for the native LitSX pipeline and direct integration release"
date: 24-09-26
metadata:
  node_type: memory
  type: umbrella
  feature: native-litsx-pipeline
  phase: umbrella
---

# Evolit Native LitSX Pipeline — Umbrella Plan

**Complexity:** COMPLEX  
**Status:** ⏳ PLANNED  
**Program type:** PHASE PROGRAM (4 phases)

## Program Goal Charter

North star:
- Publish an Evolit release in which one native LitSX configuration safely synchronizes compiler behavior and generic integration lifecycles across every runtime path.

Definition of done:
1. Evolit exposes a typed, backward-compatible `litsx` configuration and generic factory protocol.
2. The existing `@litsx/unocss` package supplies one neutral declaration consumed directly by Evolit.
3. Shadow DOM SSR/hydration, development invalidation, production output, isolation, and regressions are verified.
4. Compatible versions are published and certified from a clean consumer.

What "verified" means:
- Every phase has a non-placeholder validate contract, automated and regression evidence, and a report. Final release gates and clean-consumer certification are green.

Scope tiers → phase mapping:
- Tier 1 generic Evolit lifecycle → Phase 1.
- Tier 2 neutral integration declaration → Phase 2.
- Tier 3 runtime and Shadow DOM proof → Phase 3.
- Tier 4 publication certification → Phase 4.
- This program retires Tiers 1–4.

Explicitly out of scope:
- Framework-specific adapters, React compatibility, Vite/PostCSS requirements, or unrelated application behavior.

Hard safety constraints:
- Never publish a package whose exact candidate has not passed its release and consumer gates.
- Never share mutable integration/compiler state across runtime instances.
- Preserve unrelated work and keep process and implementation commits separable.

## Stable Program Goal

```text
TARGET: Publish Evolit with typed native LitSX configuration and direct @litsx/unocss integration; certify a clean consumer across dev, SSR, hydration, build and standalone.
PER-PHASE LOOP: 1 RESEARCH → 2 INNOVATE → 3 PLAN-SUPPLEMENT → 4 PVL → 5 EXECUTE → 6 EVL → 7 UPDATE-PROCESS. SPEC runs once. PVL is never skipped; placeholder/partial contracts are BLOCKED. Every subagent begins with vc-context-discovery + vc-plan-discovery. Every phase-END invokes vc-agent-strategy-compare. Tiers: automated / hybrid / agent-probe.
HARD STOPS: unapproved external action; cascade BLOCKED; live-provider/cost probe; release candidate with red gates.
SAFETY: no UnoCSS-specific Evolit branches; no shared mutable state; preserve no-config behavior; no react-compat.
TEST GATES: yarn test; yarn typecheck; yarn build; yarn test:browser; yarn workspace evolit release:check; yarn release:preflight.
VALIDATE CONTRACT: per-phase inline contracts required before EXECUTE.
START: Phase 1, loop step PVL.
```

## Decision Summary

**Chosen:** a generic, factory-based `litsx.integrations` protocol. Each runtime creates instances that contribute compiler options, compiled-module processing, dependencies, generated outputs, finalization, invalidation/forget, and cleanup. Framework invariants win conflicts.

**Rejected:** Vite plugins inside Evolit; UnoCSS duck typing in core; application-coordinated primitives; mutable engines stored in cached configuration objects.

## Phase Sequence

| Phase | Plan | Scope | Depends on |
|---|---|---|---|
| 1 | `phase-01-evolit-pipeline_PLAN_24-09-26.md` | Typed generic lifecycle and tests | — |
| 2 | `phase-02-unocss-integration_PLAN_24-09-26.md` | Neutral factory in existing `@litsx/unocss` | Phase 1 |
| 3 | `phase-03-shadow-runtime-verification_PLAN_24-09-26.md` | Fixture and all runtime proofs | Phases 1–2 |
| 4 | `phase-04-release-certification_PLAN_24-09-26.md` | Docs, changesets, publication and clean consumer | Phases 1–3 |

## Per-Phase Entry / Exit Gates

| Phase | Entry | Exit |
|---|---|---|
| 1 | SPEC and decision locked | Generic lifecycle suite and package tests green |
| 2 | Phase 1 protocol stable | Neutral factory and existing integration regressions green |
| 3 | Local compatible packages | Node/browser/runtime/regression matrix green |
| 4 | Phases 1–3 verified | Published clean consumer green |

## Durable Report Destinations

| Phase | Report |
|---|---|
| 1 | `phase-01-evolit-pipeline_REPORT_24-09-26.md` |
| 2 | `phase-02-unocss-integration_REPORT_24-09-26.md` |
| 3 | `phase-03-shadow-runtime-verification_REPORT_24-09-26.md` |
| 4 | `phase-04-release-certification_REPORT_24-09-26.md` |

## Program Status Table

| Phase | Status |
|---|---|
| 1 — Evolit pipeline | ✅ VERIFIED |
| 2 — UnoCSS integration | 🔄 EXECUTE |
| 3 — Runtime verification | ⏳ PLANNED |
| 4 — Release certification | ⏳ PLANNED |

## Per-Phase Loop

Each phase follows `R → I → P → PVL → E → EVL → UP`; PVL is mandatory and a placeholder contract blocks execution.

## Global Constraints

- No Evolit–UnoCSS adapter, UnoCSS import/branch in Evolit core, React compatibility, or application-owned Vite/PostCSS pipeline.
- Compiler `filename`, target `ssr`, source-map policy, and framework lowering invariants cannot be removed by app configuration.
- Integration errors name integration, phase, mode/target and module/output while preserving `cause`.

## Touchpoints

- Evolit config, compiler, client assets, build, deployment runtime, server, SSR adapter, public exports, tests and docs.
- `@litsx/unocss` declarations, neutral engine/factory, tests and docs.
- Changesets, lockfiles, release automation and clean-consumer fixture.

## Public Contracts

- Typed `litsx` configuration and generic integration factory protocol.
- Neutral combined declaration exported by `@litsx/unocss`.
- No-config applications remain compatible.

## Blast Radius

- More than 20 source/test/docs/release files across two repositories; public API, compiler, HMR, SSR/hydration and publication risk.

## Verification Evidence

| Gate / Scenario | Strategy | Evidence class | Proves SPEC criterion |
|---|---|---|---|
| Generic lifecycle suites | Fully-Automated | product-behavior | AC1–AC2 |
| Direct UnoCSS Node/browser suites | Fully-Automated | integration-runtime | AC3–AC8 |
| Existing regressions/release gates | Fully-Automated | integration-runtime | AC9 |
| Published clean consumer | Hybrid | artifact-certification | AC10 |

## Test Infra Improvement Notes

- Add reusable external-integration fixture helpers and exact generated-asset assertions.

## Resume and Execution Handoff

- Selected plan: this umbrella; current plan `phase-01-evolit-pipeline_PLAN_24-09-26.md`.
- Outer RESEARCH/SPEC/INNOVATE/PLAN complete; Phase 1 validate contract pending.
- Context: repository, tests, CI/CD, autopilot and phase-program protocols.
- Next: validate Phase 1, then implement its generic Evolit scope.

## Current Execution State

Last updated: 24-09-26  
Completed phases: outer RESEARCH, SPEC, INNOVATE, PLAN  
Current phase: Phase 2 — neutral UnoCSS integration  
Current loop step: EVL  
Validate-contract status: Phase 1 PASS; Phase 2 implementation under validation  
Program Net Gate: CONDITIONAL

## Validate Contract

(placeholder — vc-validate-agent writes this section before EXECUTE)
