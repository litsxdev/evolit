# Phase Blast-Radius Registry

| Phase | Repository | Owned surfaces | Shared surfaces |
|---|---|---|---|
| 1 | evolit | generic pipeline and fake integration tests | compiler, config, runtime, assets |
| 2 | litsx | neutral `@litsx/unocss` factory/tests/docs | integration protocol contract |
| 3 | evolit | direct fixture and runtime verification | Phase 1 compiler/runtime/assets |
| 4 | both | docs, changesets, versions, release evidence | package metadata/lockfiles |

Only one phase writes a repository at a time. Phase 3 may adjust Phase 1 surfaces only for verified integration defects recorded in its report.
