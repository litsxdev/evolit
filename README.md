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
npx nextsx@alpha my-site
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

`nextsx <directory>` copies that template, writes a site `package.json`, and leaves the app ready
to run. `nextsx init <directory>` is supported as an explicit equivalent.

## Architecture

The current runtime is split into a few small layers:

- `src/app-discovery.js`: scans `app/` and builds the route table
- `src/compiler.js`: compiles LitSX-authored modules into `.nextsx/`
- `src/render.js`: resolves route modules and builds the route render tree
- `src/ssr-adapter.js`: internal boundary around `@litsx/ssr`
- `src/server.js`: serves HTTP requests
- `src/scaffold.js`: creates new site projects from templates
- `src/cli.js`: framework entrypoint

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

`nextsx` currently normalizes those policies to:

- `dynamic`: render on every request
- `static`: prerender in `build` and serve from the response cache in `start`
- `revalidate`: cache the HTML response for `N` seconds and regenerate on expiry

The same semantics work in local development and in production runtimes. Only the backing cache
store changes.

The default cache key includes the pathname and query string. Reading the `request` prop, request
headers, cookies, or `requestUrl()` makes the completed render dynamic; it is never stored in the
HTML response cache. `routeConfig.cache` is the sole authority for HTML caching; setting a
`Cache-Control` response header does not alter that policy.

## Request APIs

Server pages and layouts can access the active Web Request context through `nextsx/server`:

```js
import {
  cookies,
  headers,
  notFound,
  redirect,
  requestUrl,
  responseHeaders,
} from "nextsx/server";

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

## Route Boundaries

`not-found.litsx` and `error.litsx` are resolved from the current route directory up to `app/`.
The nearest file wins and its output is wrapped by the route layouts. A root `app/not-found.litsx`
also handles unmatched URLs; without one, nextsx returns its minimal built-in 404 document.

```js
// app/blog/error.litsx
export default async function BlogError({ error }) {
  return `<p>Could not load this post: ${error.message}</p>`;
}
```

Boundaries always bypass the route response cache. `loading.litsx` is intentionally not supported
yet: it requires an end-to-end streaming document transport rather than an HTML-string fallback.
In production, `error.litsx` receives a generic error with an opaque `digest`; the original error
is reported only on the server.

## Route Handlers

`route.js`, `route.ts`, and the other supported JS/TS module variants expose HTTP endpoints from
`app/`. Export a function named after each supported method and return a standard Web `Response`:

```js
// app/api/status/route.js
import { cookies, responseHeaders } from "nextsx/server";

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

`nextsx build` uses those params to prefill the route cache for concrete pathnames. Paths that were
not prerendered still fall back to normal runtime rendering and cache population according to the
route cache policy.

## Response Cache Adapters

By default, `nextsx` uses:

- in `dev`: an in-memory response cache
- in `start`: a filesystem-backed response cache under `.nextsx/build/route-cache`

That runtime is configurable through `nextsx.config.js`:

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

The framework also exports `ObjectStorageResponseCacheStore`, which is intended for object-store
backends such as S3. A concrete app can wire it to the AWS SDK without pulling AWS dependencies
into `nextsx` itself.

Example shape:

```js
import { ObjectStorageResponseCacheStore } from "nextsx";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const bucket = process.env.NEXTSX_CACHE_BUCKET;

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

`nextsx build` emits `deploy-routes.json` as a platform-neutral routing contract. Version 2
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

`nextsx` now renders route/layout trees through `@litsx/ssr`.

The current integration uses `renderDocument(...)` to produce the final HTML
document for each route. That gives the framework:

- LitSX-authored SSR rendering
- framework-owned metadata to document-shell mapping
- LitSX-owned hydratable module registration through `@litsx/ssr/hydration`
- a stable internal adapter boundary for future evolution

The remaining SSR work in `nextsx` is mostly framework-specific:

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
