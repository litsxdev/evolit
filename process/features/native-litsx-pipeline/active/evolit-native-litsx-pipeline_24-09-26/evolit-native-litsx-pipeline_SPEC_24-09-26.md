---
name: spec:evolit-native-litsx-pipeline
description: "Declarative native LitSX pipeline configuration and direct integrations for Evolit"
date: 24-09-26
metadata:
  node_type: memory
  type: spec
  feature: native-litsx-pipeline
  phase: umbrella
---

# Evolit Native LitSX Pipeline — Program SPEC

## Summary

Evolit applications can configure the native LitSX compiler and its build integrations once, from the framework configuration, while Evolit consistently carries those choices through development, server rendering, browser hydration, production builds, and standalone execution.

## User Stories / Jobs To Be Done

- As an Evolit application author, I want one declarative LitSX configuration so that compiler and integration behavior cannot drift between runtime paths.
- As an integration author, I want a generic lifecycle contract so that compilation, generated outputs, invalidation, and cleanup stay encapsulated in my integration.
- As a component author, I want native Shadow DOM output to match before and after hydration so that styling remains correct and isolated.
- As a release consumer, I want installable published versions that work from a clean project without local patches or an extra build pipeline.

## What The User Wants (Behavioral Outcomes)

- A concise configuration enables native compiler options and an existing styling integration together.
- Development updates add and remove generated styles without stale or duplicated output.
- Server-rendered Shadow DOM contains the same component styles that hydration preserves.
- Document-wide theme output appears once and remains inherited by component shadow roots.
- Concurrent projects and builds never share integration state.
- Applications that omit the new configuration behave exactly as before.

## Flow / State Diagram

```text
[load configuration] -> [create isolated pipeline] -> [compile server/browser graphs]
                                      |                           |
                                      v                           v
                         [collect dependencies/outputs] -> [finalize graph]
                                                                  |
                                                       [emit/link assets]
                                                                  |
                         [source change] -> [invalidate/remove] -> [serve/hydrate]
```

## Acceptance Criteria (Testable Outcomes)

- AC1: Native compiler options and compiler contributions are applied through one typed configuration without allowing framework invariants to be removed.
  proven by: generic integration compiler-options contract suite
  strategy: Fully-Automated
- AC2: A generic non-styling integration can process compiled modules, declare dependencies and outputs, finalize the graph, invalidate stale results, clean up, and keep state isolated.
  proven by: generic integration lifecycle and concurrent-isolation suite
  strategy: Fully-Automated
- AC3: The existing utility-style integration is configured directly with one declaration and no framework-specific adapter.
  proven by: clean Evolit UnoCSS fixture configuration assertion
  strategy: Fully-Automated
- AC4: Two native Shadow DOM components receive shared, exclusive, dynamic, imported, guarded, arbitrary, data, aria, and dark-mode utilities in the correct ownership boundary.
  proven by: UnoCSS fixture SSR and browser component-style scenarios
  strategy: Fully-Automated
- AC5: Component preflight and authored styles retain deterministic ordering in Declarative Shadow DOM and after hydration.
  proven by: SSR markup ordering and hydrated adopted-style assertions
  strategy: Fully-Automated
- AC6: Theme variables and global layers are linked exactly once in the document and inherit into every shadow root.
  proven by: document asset cardinality and computed-style browser assertions
  strategy: Fully-Automated
- AC7: Adding or removing classes and changing style configuration updates affected development output without stale CSS or duplication.
  proven by: development watcher/HMR mutation scenarios
  strategy: Fully-Automated
- AC8: Production builds are repeatable apart from documented timestamps, link generated assets correctly, and isolate concurrent projects.
  proven by: repeated and concurrent production build comparison suite
  strategy: Fully-Automated
- AC9: Routing, SSR, hydration, source maps, client assets, cache behavior, and data-client integration remain unchanged when LitSX configuration is absent.
  proven by: existing Node, Playwright, typecheck, and build regression gates
  strategy: Fully-Automated
- AC10: Clean consumers can install the published versions and pass development, SSR, hydration, and production checks without patches or a separate Vite/PostCSS pipeline.
  proven by: packed/published clean-consumer certification fixture
  strategy: Hybrid

## Out Of Scope

- A framework-specific UnoCSS adapter, React compatibility mode, application-specific storefront behavior, or exposing build-tool internals as the primary API.

## Constraints

- Native LitSX and Shadow DOM remain the default; Evolit never imports UnoCSS core or contains UnoCSS-specific branches.
- Integration state is created per development server, build, or standalone runtime.
- Existing applications have no migration requirement.
- Publication only follows green exact-candidate validation.

## Open Questions

- None.

## Background / Research Findings

Evolit currently calls the compiler directly with framework-owned options and has no generic virtual-output lifecycle. The existing utility integration exposes the required low-level engine operations, but its combined facade is build-tool-specific. A neutral factory descriptor is required to satisfy the single-declaration outcome without framework-specific detection.
