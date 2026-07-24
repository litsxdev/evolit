# nextsx Showcase

This app is the first manual validation target for `nextsx` as a standalone consumer.

It intentionally exercises:

- a static home route
- a dynamic route at `app/blog/[slug]/page.litsx`
- a route with `generateStaticParams()` at `app/library/[category]/[slug]/page.litsx`
- a route with `{ revalidate: 60 }` at `app/news/[slug]/page.litsx`
- imported CSS and image assets
- a hydratable LitSX-authored component on the home page

## Run

```sh
yarn install
yarn start
```

Build the production output before `start`:

```sh
yarn build
```

This example intentionally links the local framework checkout through `portal:../..`, so the
scripts set `NODE_OPTIONS=--preserve-symlinks`.

## Manual Checks

1. Open `/` and confirm the page renders the showcase cards and a hydration bootstrap.
2. Open `/blog/hello-world` and confirm the slug is rendered from params.
3. Open `/library/books/field-guide` and confirm it returns `x-nextsx-cache: HIT` after `start`.
4. Open `/library/books/non-listed` twice and confirm it goes `MISS` then `HIT`.
5. Open `/news/launch-week` twice and confirm it goes `MISS` then `HIT`.
