import { html } from '/_nextsx/shared/lit-C-FzaC7s.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements-gEpUokq0.mjs';
import PageFrame from './components/page-frame-ayh-CziY.mjs';
import '/_nextsx/shared/litsx__core-BKwHhaBh.mjs';

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
//# sourceMappingURL=error-CTWVzZnh.mjs.map
