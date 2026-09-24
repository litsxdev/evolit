---
name: plan:evolit-native-litsx-pipeline-phase-04-release-certification
description: "Phase 4: documentation, publication and clean-consumer certification"
date: 24-09-26
metadata: { node_type: memory, type: phase-plan, feature: native-litsx-pipeline, phase: phase-04 }
---

# Phase 04 — Release and Consumer Certification

**Date**: 24-09-26  
**Complexity**: COMPLEX  
**Status**: ⏳ PLANNED

## Context and Goals

This phase certifies artifacts, documentation and registry releases. Read `process/context/all-context.md`, `process/context/cicd/all-cicd.md`, testing context and all prior reports; post-phase testing must use published versions.

## Phase Completion Rules

The phase reaches ✅ VERIFIED only after exact-candidate preflight, protected publication, clean-consumer runtime evidence and the user's explicit publication confirmation are recorded.

## Purpose

Document the final API, publish compatible packages in dependency order, and prove them from a clean consumer.

## Entry Gate

- Phases 1–3 verified; exact release candidates pass full gates.

## Blast Radius

- READMEs, example, changesets/changelogs, lockfiles, release workflows, npm/GitHub releases and a temporary consumer.

## Implementation Checklist

- [ ] Document composition, isolation, errors, invalidation, outputs/assets, migration and limits.
- [ ] Add minimal native LitSX + UnoCSS + Shadow DOM example and exact config.
- [ ] Add changesets and run immutable preflight/package checks.
- [ ] Publish dependency package first if changed; update Evolit to its published version.
- [ ] Publish Evolit through the protected mechanism.
- [ ] Install both versions in a clean consumer and pass dev/SSR/hydration/build/standalone checks.
- [ ] Record versions, URLs, commands and outcomes.

## Acceptance Criteria

- [ ] Documentation states exact configuration, outputs, compatibility, migration and limits.
- [ ] Registry versions install without patches and pass the clean-consumer matrix.
- [ ] Release metadata and verification evidence identify the exact published candidates.

## Exit Gate

```bash
yarn workspace evolit release:check
yarn release:preflight
```

## Blockers That Would Justify BLOCKED Status

- Protected publisher unavailable, required CI red, or registry artifacts fail clean install.

## Phase Loop Progress

- [ ] 1. RESEARCH
- [ ] 2. INNOVATE
- [ ] 3. PLAN-SUPPLEMENT
- [ ] 4. PVL
- [ ] 5. EXECUTE
- [ ] 6. EVL
- [ ] 7. UPDATE-PROCESS

## Touchpoints

- Published surface, documentation, release metadata and external certification.

## Public Contracts

- Published versions and exact supported consumer configuration.

## Verification Evidence

| Gate / Scenario | Strategy | Evidence class | Proves SPEC criterion |
|---|---|---|---|
| Release preflight/pack inspection | Fully-Automated | artifact-certification | AC9, AC10 |
| Published clean-consumer matrix | Hybrid | product-behavior | AC10 |

Artifact-certification is helper-integrity evidence only; AC10 also requires the product-behavior consumer row and cannot pass from packaging evidence alone.

## Test Infra Improvement Notes

(none identified yet)

## Resume and Execution Handoff

- Execute anchor: this file. Supporting files: umbrella, SPEC and all earlier phase reports.
- Selected plan: this file; publication is authorized only after exact-candidate gates pass.
- Next instruction: run release PVL and exact-candidate preflight before publishing.

## Validate Contract

(placeholder — vc-validate-agent writes this section before EXECUTE)

## Next Instruction

After Phase 3, run release PVL and exact-candidate preflight before publication.
