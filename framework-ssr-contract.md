# Framework SSR Contract

This document describes the SSR primitives a framework needs from LitSX.

It is intentionally written without coupling the contract to `nextsx`.
The goal is to define what a framework consumer needs from `@litsx/ssr`, not
to push framework concepts down into the SSR package.

## Goal

`@litsx/ssr` should be framework-agnostic while still being framework-usable.

That means:

- no routing concepts
- no layout conventions
- no app directory assumptions
- no build manifest assumptions
- no framework-owned dev server model

But it must still expose enough primitives for a framework to:

- render LitSX-authored UI on the server
- stream or serialize HTML
- inject document shells
- discover hydration requirements
- carry request-scoped execution state
- resolve built client assets

## Non-Goals

The SSR package should not define:

- route params
- loaders
- actions
- middleware
- file-based conventions
- framework config formats
- deployment adapters
- cache invalidation policy

Those belong to frameworks, not to the rendering substrate.

## Required Primitive Areas

## 1. Render Entry Primitives

A framework needs a way to render server output from either:

- an already-constructed render value
- an authored entry description resolved by the SSR package

The package should support both because frameworks may render from different
integration points:

- direct route/layout component composition in memory
- authored entry resolution through a loader callback

Minimum primitive shape:

- `renderToString(input, options?)`
- `renderToStream(input, options?)`
- `renderDocument(input, options?)`

Where `input` can be either:

- a renderable value
- a structured authored-entry object

Why this matters:

- some frameworks build the tree before calling SSR
- some frameworks want SSR to own authored module loading
- some build pipelines want prerendering without importing app code directly

## 2. Request-Scoped Execution Context

Every public SSR render must create one isolated request execution context.

That context must be:

- stable for the whole render
- shared across nested server component calls
- preserved across suspense retries
- isolated from concurrent requests

Frameworks must not need to construct or inject this context manually.

Framework requirement:

- route code, server helpers, and hooks must be able to read request-scoped
  state from `@litsx/core`
- SSR metadata config must remain distinct from execution context

This is important because frameworks will use request context for:

- auth/session propagation
- per-request caches
- tracing
- locale
- feature flags
- request-bound data deduplication

## 3. Structured Render Result

Returning only an HTML string is not enough.

A framework needs structured SSR metadata alongside the rendered HTML.

Minimum result surface:

- `html`
- `clientImports`
- `hydrationData`
- `renderClientImports()`
- `renderModulePreloads()`
- `renderHydrationData()`

For document rendering, the result should additionally expose:

- `document`
- `bootstrap`
- `head`
- document-template context or equivalent shell metadata

Why this matters:

- frameworks need to decide how to assemble the final document
- frameworks often want to merge framework head output with SSR-discovered data
- frameworks may emit different preload strategies depending on mode

## 4. Document Shell Control

Frameworks need both:

- an opinionated document helper
- low-level control over the final shell

That means `renderDocument(...)` is valuable, but it must not be the only path.

Required capability:

- render a fragment and separately assemble the document
- or use a built-in document helper with template overrides

The document primitive should support:

- `title`
- `lang`
- extra head markup
- html/body attributes
- module preloads
- hydration payload script
- bootstrap script
- custom final template assembly

This gives frameworks enough control to integrate:

- metadata systems
- CSP policies
- framework-level body/html attributes
- custom shells for errors, previews, or edge/runtime variants

## 5. Asset Resolution Hook

A framework must be able to rewrite discovered client module ids into public
URLs.

This belongs in SSR because SSR discovers client imports, but SSR should not
own bundler semantics.

Required primitive:

- `assetResolver(moduleId) => publicUrl | null`

Why this matters:

- Vite, Rollup, and framework build manifests all resolve assets differently
- development URLs and production URLs differ
- frameworks may need hashed asset mapping

The SSR package should discover imports. The framework should decide how those
imports map to served assets.

## 6. Hydration Metadata Protocol

The hydration contract must be explicit and stable enough for framework use.

Frameworks need:

- root metadata
- serialized state payload
- discovered client imports
- a predictable script emission contract

At minimum, the SSR package should define:

- hydration root identifiers
- payload versioning
- serialized hook/root state format
- script emission helpers or raw structured data

This must remain generic. It should not assume:

- a specific router
- a specific bundler
- a specific page shell

But it must be stable enough that a framework can rely on it when building:

- automatic page hydration
- partial hydration policies
- framework-managed bootstraps

## 7. Streaming Primitive

Frameworks need a streaming option that does not throw away metadata.

Required shape:

- a `ReadableStream<string>` or equivalent stream output
- a completion handle such as `allReady`
- final metadata equivalent to string rendering once complete

Why this matters:

- frameworks may stream shell-first responses
- frameworks still need hydration metadata and client import metadata
- frameworks need a predictable point at which final metadata is complete

## 8. Suspense and Retry Semantics

Framework consumers need deterministic semantics around async rendering.

The SSR package should define:

- how suspense retries work
- whether request execution context survives retries
- how max retry/pass limits are configured
- what failure mode occurs when retry limits are exceeded

Frameworks do not need internal implementation details, but they do need
predictable external behavior.

Otherwise they cannot reason correctly about:

- timeouts
- diagnostics
- server error boundaries
- caching behavior

## 9. Error Surface

Frameworks need errors to remain attributable and interceptable.

The SSR layer should preserve:

- normal thrown errors from route/render code
- useful stack traces
- clear distinction between render errors and framework response decisions

The SSR package should not hardcode framework-level recovery behavior such as:

- 404 routing semantics
- redirect response semantics
- framework error page policies

Those should stay above the SSR layer.

## 10. Authored-Entry Loader Contract

If `@litsx/ssr` continues to support authored-entry rendering, that loader
contract should stay generic.

It should allow SSR to resolve authored modules without assuming a framework
directory layout.

The authored-entry surface should remain based on generic concepts like:

- `root`
- `template`
- `clientEntry`
- `elements(loader)`
- `render({ html })`

This is useful for:

- scaffolds
- examples
- dev helpers
- prerender scripts

But frameworks should also be free to bypass it and call SSR with already-built
render values.

## 11. Dev Helper Positioning

A dev helper such as `createSsrDevServer(...)` can exist, but it should remain
explicitly non-foundational.

Framework requirement:

- the framework must be able to ignore this helper entirely

That helper is useful for:

- examples
- standalone starters
- local authored SSR prototypes

But a framework should build on the render primitives, not on the dev helper.

## Recommended Boundary

The clean layering looks like this:

### `@litsx/core`

Owns:

- execution-context read/write primitives
- runtime semantics shared by browser and SSR
- hook/runtime behavior

### `@litsx/ssr`

Owns:

- server rendering
- hydration metadata capture
- scoped element SSR semantics
- request execution context lifecycle during SSR
- document and stream rendering primitives
- generic asset resolution hooks

### Framework Layer

Owns:

- routes
- layouts
- params/search params
- middleware
- data APIs
- redirects/not-found conventions
- dev/build orchestration
- deployment adapters
- app templates

## Practical Acceptance Test

The SSR contract is sufficient for framework use if a framework can implement
all of the following without patching SSR internals:

1. Compose a route tree in memory and render it.
2. Render the same tree either to string or to stream.
3. Build a custom HTML document shell around the rendered result.
4. Emit preload and hydration metadata using returned structured data.
5. Resolve client imports through a framework-owned asset manifest.
6. Read request-scoped execution data during the render.
7. Handle framework-level 404/redirect/error decisions outside SSR internals.

If any of those require private hooks or implementation knowledge, the SSR
surface is still too narrow for framework consumption.

## Current Read Against `feat/scoped-ssr`

The branch appears directionally correct because it already exposes:

- `renderToString(...)`
- `renderToStream(...)`
- `renderDocument(...)`
- hydration metadata helpers
- authored-entry rendering
- request execution context semantics
- `assetResolver`

The main remaining bar is not adding `nextsx` concepts.
It is making sure these primitives stay stable, generic, and sufficient.
