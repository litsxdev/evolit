# Evolit

Evolit is a LitSX SSR framework and its first-party integration packages.

This repository is a Yarn workspace monorepo. Publishable packages live under
`packages/` and are versioned independently with Changesets.

| Package | Description |
| --- | --- |
| [`evolit`](./packages/evolit) | Core SSR runtime, routing and client navigation. |

Run `yarn test`, `yarn typecheck`, or `yarn test:browser` from the repository
root. Use `yarn changeset` for every releasable package change.
