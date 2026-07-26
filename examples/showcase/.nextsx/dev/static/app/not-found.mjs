import { html } from '/_nextsx/shared/lit.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements.mjs';
import PageFrame from './components/page-frame.mjs';
import '/_nextsx/shared/litsx__core.mjs';

const metadata = {
  title: "Page not found | nextsx Showcase"
};
async function NotFoundPage() {
  return __litsxScopedTemplate(html`<page-frame eyebrow="404" title="This route does not exist."><p><a href="/">Return to the showcase</a></p></page-frame>`, {
    "page-frame": PageFrame
  });
}
NotFoundPage[LITSX_SERVER_COMPONENT] = true;

export { NotFoundPage as default, metadata };
//# sourceMappingURL=not-found.mjs.map
