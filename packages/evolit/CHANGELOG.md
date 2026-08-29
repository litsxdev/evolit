# evolit

## 0.1.5

### Patch Changes

- b6af27f: Canonicalize hydrated package subpaths through the shared vendor runtime so external LitSX components keep one browser constructor identity in development and production. Declared workspace dependencies retain their package identity even when hydration metadata contains a physical symlink target, production builds warn when the SSR graph imports a package declared only in `devDependencies`, and production startup reuses the shared import map emitted by the build instead of regenerating shared assets.

## 0.1.4

### Patch Changes

- 50a2c32: Resolve import-only ESM package roots through exported manifests and route CSS
  package subpaths, including their relative dependencies, through Evolit's static
  asset pipeline instead of shared JavaScript vendor chunks.

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
