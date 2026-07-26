import { html } from "lit";
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from "@litsx/core/elements";
// @ts-nocheck
import PageFrame from "../../components/page-frame.mjs?t=1784922040738";
const showcaseRuntimeState = /** @type {{ __NEXTSX_SHOWCASE_NEWS_COUNTER?: number }} */globalThis;
showcaseRuntimeState.__NEXTSX_SHOWCASE_NEWS_COUNTER ??= 0;
export const routeConfig = {
  cache: {
    revalidate: 60
  }
};

/**
 * @param {{ params: { slug: string } }} props
 */
export default async function NewsEntryPage(props) {
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