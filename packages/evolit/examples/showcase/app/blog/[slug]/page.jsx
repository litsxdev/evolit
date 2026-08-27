// @ts-nocheck
import PageFrame from "@/app/components/page-frame";

/**
 * @param {{ params: { slug: string } }} props
 */
export default async function BlogEntryPage(props) {
  const { params } = props;

  return (
    <PageFrame eyebrow="Dynamic route" title={params.slug}>
      This page proves the framework passes route params from /blog/[slug] directly into
      the server component request context.
    </PageFrame>
  );
}
