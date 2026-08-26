// @ts-nocheck
import PageFrame from "../../components/page-frame.jsx";

const showcaseRuntimeState = /** @type {{ __EVOLIT_SHOWCASE_NEWS_COUNTER?: number }} */ (globalThis);

showcaseRuntimeState.__EVOLIT_SHOWCASE_NEWS_COUNTER ??= 0;

export const routeConfig = {
  cache: { revalidate: 60 },
};

/**
 * @param {{ params: { slug: string } }} props
 */
export default async function NewsEntryPage(props) {
  const { params } = props;

  showcaseRuntimeState.__EVOLIT_SHOWCASE_NEWS_COUNTER += 1;
  const renderCount = showcaseRuntimeState.__EVOLIT_SHOWCASE_NEWS_COUNTER;

  return (
    <PageFrame eyebrow="Stale-while-revalidate" title={params.slug}>
      Render count: <strong>{String(renderCount)}</strong>
    </PageFrame>
  );
}
