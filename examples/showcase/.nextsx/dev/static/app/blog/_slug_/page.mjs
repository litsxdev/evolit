import { html } from '/_nextsx/shared/lit.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements.mjs';
import PageFrame from '../../components/page-frame.mjs';
import '/_nextsx/shared/litsx__core.mjs';

/**
 * @param {{ params: { slug: string } }} props
 */
async function BlogEntryPage(props) {
  const {
    params
  } = props;
  return __litsxScopedTemplate(html`<page-frame eyebrow="Dynamic route" title="${params.slug}">This page proves the framework passes route params from /blog/[slug] directly into the server component request context.</page-frame>`, {
    "page-frame": PageFrame
  });
}
BlogEntryPage[LITSX_SERVER_COMPONENT] = true;

export { BlogEntryPage as default };
//# sourceMappingURL=page.mjs.map
