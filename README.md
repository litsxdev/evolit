# nextsx

`nextsx` is a Next.js-style framework built around LitSX.

This repository now contains the first framework MVP:

- file-based routing from `app/`
- nested `layout` composition
- server rendering through `@litsx/ssr`
- a small `nextsx` CLI with `init`, `dev`, `build`, and `start`
- on-demand compilation of authored `.litsx` modules through `@litsx/compiler`
- a starter template for generating new sites

## MVP Scope

The current implementation is intentionally narrow.

It focuses on the core contract that matters first:

- route modules live in `app/**/page.*`
- layout modules live in `app/**/layout.*`
- page and layout modules export a default async function
- pages receive `{ params, searchParams, request }`
- layouts receive `{ children, params, searchParams, request }`
- SSR document rendering is delegated to `@litsx/ssr`

Supported authored module extensions:

- `.litsx`
- `.litsx.jsx`
- `.js`
- `.jsx`
- `.ts`
- `.tsx`
- `.mjs`

## Commands

```sh
yarn install
node ./src/cli.js init my-site
```

Additional commands:

```sh
cd my-site
yarn install
yarn dev
```

Framework commands inside a generated site:

```sh
yarn build
yarn start
```

## Template

The framework ships a starter at `templates/default`.

`nextsx init <directory>` copies that template, writes a site `package.json`, and leaves the
app ready to run.

## Architecture

The current runtime is split into a few small layers:

- `src/app-discovery.js`: scans `app/` and builds the route table
- `src/compiler.js`: compiles LitSX-authored modules into `.nextsx/`
- `src/render.js`: resolves route modules and builds the route render tree
- `src/ssr-adapter.js`: internal boundary around `@litsx/ssr`
- `src/server.js`: serves HTTP requests
- `src/scaffold.js`: creates new site projects from templates
- `src/cli.js`: framework entrypoint

## SSR Status

`nextsx` now renders route/layout trees through `@litsx/ssr`.

The current integration uses `renderDocument(...)` to produce the final HTML
document for each route. That gives the framework:

- LitSX-authored SSR rendering
- framework-owned metadata to document-shell mapping
- a stable internal adapter boundary for future evolution

The remaining SSR work in `nextsx` is mostly framework-specific:

- client asset pipeline and hydration story
- asset resolution into public browser URLs
- richer metadata and head management
- streaming responses

## Next Steps

This MVP is enough to validate the direction. The likely next milestones are:

- dev HMR instead of request-time recompilation
- route handlers and data loading primitives
- static generation and incremental caching
- config surface and deployment adapter contracts
