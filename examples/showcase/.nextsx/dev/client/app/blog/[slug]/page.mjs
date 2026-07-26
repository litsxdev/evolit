import { html } from "lit";
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from "@litsx/core/elements";
// @ts-nocheck
import PageFrame from "../../components/page-frame.mjs";

/**
 * @param {{ params: { slug: string } }} props
 */
export default async function BlogEntryPage(props) {
  const {
    params
  } = props;
  return __litsxScopedTemplate(html`<page-frame eyebrow="Dynamic route" title="${params.slug}">This page proves the framework passes route params from /blog/[slug] directly into the server component request context.</page-frame>`, {
    "page-frame": PageFrame
  });
}
BlogEntryPage[LITSX_SERVER_COMPONENT] = true;