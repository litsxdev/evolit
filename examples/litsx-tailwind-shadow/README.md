# Native LitSX + Tailwind CSS + Shadow DOM

This minimal Evolit application uses the build-tool-neutral root integration exported by
`@litsx/tailwind`. Install `evolit`, `@litsx/tailwind` and `lit`, then run `evolit dev` or
`evolit build && evolit start` from this directory.

There is no Evolit adapter, Vite plugin, PostCSS pipeline or manually coordinated CSS generation.
The single declaration in `evolit.config.js` contributes LitSX compiler plugins, component-owned
utilities, Shadow DOM preflight, invalidation and the one document theme asset. The example uses
native LitSX only; `react-compat` remains disabled.
