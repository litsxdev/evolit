# evolit

`evolit` is a convention-driven application framework built around LitSX and web components.

This repository now contains the first framework MVP:

- file-based routing from `app/`
- nested `layout` composition
- server rendering through `@litsx/ssr`
- a small `evolit` CLI with `init`, `dev`, `build`, and `start`
- on-demand compilation of authored `.jsx` modules through `@litsx/compiler`
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

- `.js`
- `.jsx`
- `.ts`
- `.tsx`
- `.mjs`

### Internal imports

Imports beginning with `@/` resolve from the application root in server and browser graphs. This
keeps internal imports stable when modules move between route directories:

```jsx
import FeatureCard from "@/app/components/feature-card";
import { formatPrice } from "@/lib/format-price";
```

Generated applications declare `"@/*": ["./*"]` in `jsconfig.json`, so editors and typechecking
use the same convention. An explicit `@/*` mapping in `jsconfig.json` or `tsconfig.json` takes
priority when an application needs a different source root.

### Package CSS and static assets

Applications can import stylesheets exposed through package `exports` in the same way as local
stylesheets:

```js
import "@scope/design-system/tokens.css";
import "@scope/design-system/theme.css";
```

Evolit resolves package subpaths with ESM `import` conditions, emits exported CSS through the
route static-asset pipeline, and adds the resulting stylesheet URLs to the rendered document.
Relative `@import` rules and `url(...)` references inside package CSS are emitted and rewritten
from their location within `node_modules`. Bare package imports that resolve to JavaScript continue
to use the shared vendor runtime; CSS and other static assets do not enter vendor chunks.

## Commands

```sh
yarn install
npx -p evolit@alpha evolit my-site
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

`evolit <directory>` copies that template, writes a site `package.json`, and leaves the app ready
to run. `evolit init <directory>` is supported as an explicit equivalent. The `npx -p … evolit`
form keeps the CLI arguments unambiguous across npm versions.

## Architecture

The current runtime is split into a few small layers:

- `src/app-discovery.js`: scans `app/` and builds the route table
- `src/compiler.js`: compiles LitSX-authored modules into `.evolit/`
- `src/render.js`: resolves route modules and builds the route render tree
- `src/ssr-adapter.js`: internal boundary around `@litsx/ssr`
- `src/server.js`: serves HTTP requests
- `src/scaffold.js`: creates new site projects from templates
- `src/cli.js`: framework entrypoint

## Client Navigation

Evolit hydrates a small browser router automatically for SSR page documents. It requests a route
delta, replaces only the changed route segment, and keeps parent layouts mounted when possible.
Plain `<a>` elements remain valid SSR HTML; same-origin links are progressively intercepted after
hydration.

Use `useNavigation()` inside a LitSX browser component for imperative navigation and pending UI:

```jsx
import { useNavigation } from "evolit/navigation";

export default function CollectionControls() {
  const navigation = useNavigation();

  function changeSort(event) {
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.delete("page");
    searchParams.delete("skip");
    searchParams.set("sort", event.target.value);
    navigation.push(navigation.createHref("/explore/home-garden", searchParams));
  }

  return <select onChange={changeSort} disabled={navigation.status === "pending"}>…</select>;
}
```

The hook returns `{ status, url, pendingUrl, error, push, replace, refresh, createHref }`:

- `push(target, { scroll: false })` adds a browser-history entry. Pass
  `scroll: false` to keep the current viewport position.
- `replace(target, { scroll: false })` updates the current entry, useful for
  visual-only query state. It accepts the same scroll option.
- `refresh()` bypasses the client delta cache for the current URL.
- `createHref(pathname, searchParams)` creates a relative internal URL. It accepts standard
  `URLSearchParams`, preserving repeated keys such as `facet=brand&facet=material`.

`createHref` can also be imported directly from `evolit/navigation`; it is browser-free and safe to
share with server-evaluated route code. `useNavigation()` itself is browser-only and must only run
from a connected client component.

Client components can also read the active route state with browser-only hooks:

```jsx
import { useParams, useSearchParams } from "evolit/navigation";

const { slug = [] } = useParams();
const searchParams = useSearchParams();
const selectedFacets = searchParams.getAll("facet");
```

Both hooks update after client navigation. `useParams()` returns a read-only snapshot; the
`URLSearchParams` from `useSearchParams()` is a local snapshot, so build a new href and navigate to
it to update the URL.

### Development refresh

In development, each browser subscribes its active URL over the Evolit WebSocket. After source
invalidation, the server renders the fresh SSR representation once per request context and pushes
the resulting delta directly to its subscribers. No follow-up browser request is needed. Server-only
module and static-asset changes update only the affected route segment while preserving the document,
scroll position, and persistent layouts.
Changes to a hydrated client boundary rebuild its browser artifact and update the stable Evolit
development proxy registered for that tag. Existing instances receive the new implementation
without redefining the Custom Element or replacing the document. Invalid deltas and failed hot
updates still fall back to a document reload.

### Progressive links and forms

Links work without JavaScript. With JavaScript, Evolit intercepts ordinary same-origin left-clicks.
Set `data-evolit-navigation="false"` on a link to keep native navigation.

Internal `<form method="get">` elements are treated the same way: their successful controls become
`URLSearchParams` and navigate through a delta. Without JavaScript the browser submits the exact
same GET form normally. Evolit intentionally does not intercept `POST`, file-upload, external,
targeted, or opted-out forms.

### Navigation cache and document updates

The browser cache is scoped to browser-history entries, not a global URL map. Going back or forward
can reuse the delta for that exact entry; opening a new branch after going back discards its known
forward branch. This avoids an unbounded catalog cache in a long-lived tab.

- `dynamic` routes are never cached in the browser.
- `revalidate` entries remain reusable only until their route TTL expires.
- `static` entries remain reusable while their history entry exists in the current tab session.

Each delta also synchronizes route `<title>`, route-specific `<head>` markup, managed styles and
module preloads, `html`/`body` attributes, scroll position, hash targets, and focus. If a response
cannot be represented as an Evolit delta —for example a 404 from another adapter— navigation falls
back to a normal document load.

## Route Cache Policies

Route modules can export a `routeConfig` object with a `cache` policy:

```js
export const routeConfig = {
  cache: "dynamic",
};
```

```js
export const routeConfig = {
  cache: "static",
};
```

```js
export const routeConfig = {
  cache: { revalidate: 300 },
};
```

`evolit` currently normalizes those policies to:

- `dynamic`: render on every request
- `static`: prerender in `build` and serve from the response cache in `start`
- `revalidate`: cache the HTML response for `N` seconds and regenerate on expiry

Pages without `routeConfig.cache` default to `{ revalidate: 60 }`. This caches a normal SSR
render by pathname and query string while keeping content fresh without requiring a cache
declaration on every catalog or CMS page. Declare `cache: "static"` for fully static pages or
`cache: "dynamic"` when a page must always render per request.

The same semantics work in local development and in production runtimes. Only the backing cache
store changes.

The default cache key includes the pathname and query string, so `params` and `searchParams` are
cacheable by URL. Reading the `request` prop, request headers, cookies, or `requestUrl()` makes
the completed render dynamic; it is never stored in the HTML response cache. `routeConfig.cache`
is the sole authority for HTML caching; setting a
`Cache-Control` response header does not alter that policy.

## Request APIs

Server pages and layouts can access the active Web Request context through `evolit/server`:

```js
import {
  cookies,
  headers,
  notFound,
  redirect,
  requestUrl,
  responseHeaders,
} from "evolit/server";

export default async function AccountPage() {
  if (!cookies().has("session")) {
    redirect("/sign-in");
  }

  responseHeaders().set("x-account-page", "1");
  return `<p>${headers().get("user-agent")} ${requestUrl().pathname}</p>`;
}
```

`cookies()` can read, set, and delete cookies; mutations are emitted as `Set-Cookie` response
headers. `redirect()` and `permanentRedirect()` end rendering with `307` and `308` responses, and
`notFound()` renders a `404`. Reading headers, cookies, or the request URL makes the completed
render dynamic, so it is not stored by the route response cache.

## Extensions

Optional integrations are configured explicitly in `evolit.config.js`. Core only coordinates their
request and browser-navigation lifecycles: it has no knowledge of tenants, locales, catalogues, or
message formats. Plugins run in declaration order. Each request hook receives the URL produced by
the preceding hook; a `rewrite` continues the chain, while a `redirect` or `Response` stops it.

```js
// evolit.config.js
import { defineEvolitPlugin } from "evolit/extensions";

export default {
  plugins: [defineEvolitPlugin({
    name: "tenant-prefix",
    onRequest({ pathname, headers, set }) {
      const tenant = headers().get("x-tenant") ?? "public";
      set("tenant", tenant);
      if (pathname === "/shop") return { rewrite: `/tenants/${tenant}/shop` };
    },
    client: {
      module: "@example/evolit-tenant/client",
      options: { prefix: "/tenants" },
    },
  })],
};
```

`onRequest` is server-only. It can read the `Request`, headers, cookies and URL, set JSON-serializable
request values, rewrite internally, or return `{ redirect, status? }` / a Web `Response`. Reading
request-bound data marks the request dynamic. Server components and handlers read the values without
prop drilling:

```js
import { getRequestContext } from "evolit/server";

export default async function TenantPage() {
  const { tenant } = getRequestContext();
  return `<main>Tenant: ${tenant}</main>`;
}
```

The `client.module` is a bare package specifier and is the only extension code included in the
browser build. It must export a named `navigation` object (or `default`) with optional hooks:

```js
// @example/evolit-tenant/client
export const navigation = {
  // Synchronous and idempotent: it may run for generated links and intercepted links.
  transformUrl({ url, options }) {
    return url.startsWith(options.prefix) ? url : `${options.prefix}${url}`;
  },
  async beforeNavigate({ url }) {
    if (url.endsWith("/blocked")) return false;
  },
  afterNavigate({ from, url }) {
    // Browser-only analytics or state synchronization.
  },
};
```

`transformUrl` runs for `createHref()` and before a SPA navigation; `beforeNavigate` can transform
or cancel a navigation, and `afterNavigate` runs after its delta is applied. Hooks are sequential
and later hooks receive the URL returned by earlier hooks. Browser modules must not import server
code. Request values are isolated with async request context and are discarded when rendering ends.

## Route Boundaries

`not-found.jsx` and `error.jsx` are resolved from the current route directory up to `app/`.
The nearest file wins and its output is wrapped by the route layouts. A root `app/not-found.jsx`
also handles unmatched URLs; without one, evolit returns its minimal built-in 404 document.

```js
// app/blog/error.jsx
export default async function BlogError({ error }) {
  return `<p>Could not load this post: ${error.message}</p>`;
}
```

Boundaries always bypass the route response cache. `loading.jsx` is intentionally not supported
yet: it requires an end-to-end streaming document transport rather than an HTML-string fallback.
In production, `error.jsx` receives a generic error with an opaque `digest`; the original error
is reported only on the server.

## Route Handlers

`route.js`, `route.ts`, and the other supported JS/TS module variants expose HTTP endpoints from
`app/`. Export a function named after each supported method and return a standard Web `Response`:

```js
// app/api/status/route.js
import { cookies, responseHeaders } from "evolit/server";

export async function POST(request, { params, searchParams }) {
  const body = await request.json();
  cookies().set("last-action", "status", { httpOnly: true });
  responseHeaders().set("x-api-version", "1");
  return Response.json({ params, searchParams, body });
}
```

Handlers receive a Web `Request` and `{ params, searchParams }`. They are always dynamic, bypass
the HTML response cache, and return `405 Method Not Allowed` with `Allow` when the requested method
is not exported. A handler and `page.*` cannot coexist in the same segment.

## Dynamic Route Prerendering

Dynamic routes can opt into build-time prerendering by exporting `generateStaticParams()` from
layouts and/or pages:

```js
export async function generateStaticParams() {
  return [
    { slug: "guide" },
    { slug: "changelog" },
  ];
}
```

For nested dynamic routes, parent layouts and child pages compose through `params`, following the
same general model as the Next.js App Router:

```js
export async function generateStaticParams({ params }) {
  return params.category === "books"
    ? [{ slug: "guide" }]
    : [];
}
```

`evolit build` uses those params to prefill the route cache for concrete pathnames. Paths that were
not prerendered still fall back to normal runtime rendering and cache population according to the
route cache policy.

## Response Cache Adapters

By default, `evolit` uses:

- in `dev`: an in-memory response cache
- in `start`: a filesystem-backed response cache under `.evolit/build/route-cache`

That runtime is configurable through `evolit.config.js`:

```js
export default {
  responseCache: {
    async createStore({ projectRoot, mode, defaultStore }) {
      return defaultStore;
    },
    createKey({ request, routeResult }) {
      return new URL(request.url).pathname;
    },
  },
};
```

For monorepos, development watches only the application project by default. Additional source
trees can be opted into explicitly; generated output and dependency directories below every root
remain ignored:

```js
export default {
  development: {
    managedSourceRoots: ["../packages/design-system/src"],
  },
};
```

Imports outside these roots remain unmanaged and produce the existing development warning.

Evolit normally discovers browser boundaries from the static module graph and reconciles that
inventory with the components actually emitted by SSR. A genuinely computed import cannot be
enumerated at build time, so production applications can declare only those exceptional modules:

```js
export default {
  clientBoundaries: ["./src/components/dynamic-card.jsx", "@acme/ui/product-card"],
};
```

These modules are materialized as build artifacts, but are not automatically imported or
preloaded. They reach the browser only when an SSR hydration root references them.

The framework also exports `ObjectStorageResponseCacheStore`, which is intended for object-store
backends such as S3. A concrete app can wire it to the AWS SDK without pulling AWS dependencies
into `evolit` itself.

Example shape:

```js
import { ObjectStorageResponseCacheStore } from "evolit";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const bucket = process.env.EVOLIT_CACHE_BUCKET;

export default {
  responseCache: {
    async createStore() {
      return new ObjectStorageResponseCacheStore({
        prefix: "routes",
        async getObject(key) {
          try {
            const result = await s3.send(new GetObjectCommand({
              Bucket: bucket,
              Key: key,
            }));
            return await result.Body.transformToString();
          } catch (error) {
            if (error?.name === "NoSuchKey") {
              return null;
            }
            throw error;
          }
        },
        async putObject(key, value) {
          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: value,
            ContentType: "application/json; charset=utf-8",
          }));
        },
        async deleteObject(key) {
          await s3.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          }));
        },
      });
    },
    createKey({ request }) {
      return new URL(request.url).pathname;
    },
  },
};
```

That is the intended path toward deployments where:

- `CloudFront` fronts public traffic
- `S3` stores prerendered/static route responses and cacheable regenerated HTML
- `Lambda` renders only on cache misses or revalidation events

## Deployment Manifests

`evolit build` emits `deploy-routes.json` as a platform-neutral routing contract. Version 2
contains separate collections for HTML routes and HTTP handlers:

```json
{
  "version": 2,
  "routes": [
    { "pathname": "/news/:slug", "cache": { "revalidate": 60 } }
  ],
  "handlers": [
    {
      "pathname": "/api/echo/:slug",
      "methods": ["GET", "POST"],
      "runtime": "server",
      "cache": "dynamic"
    }
  ]
}
```

The framework owns this manifest schema. A hosting-specific adapter can use it to route static
assets and cached HTML to object storage, while always sending declared handlers to server compute.

## SSR Status

`evolit` now renders route/layout trees through `@litsx/ssr`.

The current integration uses `renderDocument(...)` to produce the final HTML
document for each route. That gives the framework:

- LitSX-authored SSR rendering
- framework-owned metadata to document-shell mapping
- LitSX-owned hydratable module registration through `@litsx/ssr/hydration`
- a stable internal adapter boundary for future evolution

The remaining SSR work in `evolit` is mostly framework-specific:

- client asset pipeline and public client URL resolution
- minimal framework bootstrap assembly around LitSX hydration primitives
- asset resolution into public browser URLs
- richer metadata and head management
- streaming responses

## Next Steps

This MVP is enough to validate the direction. The likely next milestones are:

- dev HMR instead of request-time recompilation
- data loading primitives
- middleware and rewrite rules
- public asset directory support
- hosting-specific deployment adapters
