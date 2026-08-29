---
"evolit": patch
---

Canonicalize hydrated package subpaths through the shared vendor runtime so external LitSX components keep one browser constructor identity in development and production. Declared workspace dependencies retain their package identity even when hydration metadata contains a physical symlink target, production builds warn when the SSR graph imports a package declared only in `devDependencies`, and production startup reuses the shared import map emitted by the build instead of regenerating shared assets.
