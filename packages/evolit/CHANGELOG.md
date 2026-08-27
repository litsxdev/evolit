# evolit

## 0.1.3

### Patch Changes

- 4f02bfd: Remove the deprecated `@litsx/typescript` integration, use standard TypeScript
  for project typechecking, and update LitSX compiler, core, and SSR dependencies
  to their current `next` releases.

## 0.1.2

### Patch Changes

- ee07e11: Resolve `@/…` imports from the application root across server and browser compilation, and configure the alias in newly scaffolded applications.

## 0.1.1

### Patch Changes

- 70f00db: Migrate Evolit, generated applications, and the showcase to LitSX 1.0 standard JSX authoring and the latest `next` compiler, core, and SSR runtimes.

## 0.1.0

### Patch Changes

- 63284c1: Forward a page's standard client ref through async layout composition and restore it during incremental navigation hydration.
- 017cccf: Add the first generic extension lifecycle for server requests and browser navigation.
