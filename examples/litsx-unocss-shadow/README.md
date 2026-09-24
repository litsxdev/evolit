# Native LitSX + UnoCSS + Shadow DOM

This minimal Evolit application uses the build-tool-neutral integration exported by
`@litsx/unocss`. Install `evolit`, `@litsx/unocss`, `unocss` and `lit`, then run
`evolit dev` or `evolit build && evolit start` from this directory.

There is no Evolit adapter, Vite plugin, PostCSS pipeline or authored global CSS import. The single
entry in `evolit.config.js` contributes LitSX compiler plugins, component-owned utilities, the
Shadow DOM preflight and the one document theme asset.

