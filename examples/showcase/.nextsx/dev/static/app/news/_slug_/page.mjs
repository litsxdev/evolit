import { html } from '/_nextsx/shared/lit.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements.mjs';
import PageFrame from '../../components/page-frame.mjs';
import '/_nextsx/shared/litsx__core.mjs';

const showcaseRuntimeState = /** @type {{ __NEXTSX_SHOWCASE_NEWS_COUNTER?: number }} */globalThis;
showcaseRuntimeState.__NEXTSX_SHOWCASE_NEWS_COUNTER ??= 0;
const routeConfig = {
  cache: {
    revalidate: 60
  }
};

/**
 * @param {{ params: { slug: string } }} props
 */
async function NewsEntryPage(props) {
  const {
    params
  } = props;
  showcaseRuntimeState.__NEXTSX_SHOWCASE_NEWS_COUNTER += 1;
  const renderCount = showcaseRuntimeState.__NEXTSX_SHOWCASE_NEWS_COUNTER;
  return __litsxScopedTemplate(html`<page-frame eyebrow="Stale-while-revalidate" title="${params.slug}">Render count: <strong>${String(renderCount)}</strong></page-frame>`, {
    "page-frame": PageFrame
  });
}
NewsEntryPage[LITSX_SERVER_COMPONENT] = true;

export { NewsEntryPage as default, routeConfig };
//# sourceMappingURL=page.mjs.map
