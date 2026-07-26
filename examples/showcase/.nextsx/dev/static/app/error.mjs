import { html } from '/_nextsx/shared/lit.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements.mjs';
import PageFrame from './components/page-frame.mjs';
import '/_nextsx/shared/litsx__core.mjs';

const metadata = {
  title: "Application error | nextsx Showcase"
};
async function ErrorPage({
  error
}) {
  return __litsxScopedTemplate(html`<page-frame eyebrow="500" title="The route could not be rendered."><p>Error: <strong>${error instanceof Error ? error.message : "Unknown error"}</strong></p><p><a href="/">Return to the showcase</a></p></page-frame>`, {
    "page-frame": PageFrame
  });
}
ErrorPage[LITSX_SERVER_COMPONENT] = true;

export { ErrorPage as default, metadata };
//# sourceMappingURL=error.mjs.map
