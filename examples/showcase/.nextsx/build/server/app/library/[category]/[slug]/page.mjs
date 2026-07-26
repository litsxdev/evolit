import { html } from "lit";
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from "@litsx/core/elements";
// @ts-nocheck
import PageFrame from "../../../components/page-frame.mjs";
export const routeConfig = {
  cache: "static"
};

/**
 * @param {{ params: { category: string } }} context
 */
export async function generateStaticParams(context) {
  const {
    params
  } = context;
  if (params.category === "books") {
    return [{
      slug: "field-guide"
    }, {
      slug: "atlas-of-signals"
    }];
  }
  if (params.category === "maps") {
    return [{
      slug: "north-ridge"
    }];
  }
  return [];
}

/**
 * @param {{ params: { category: string, slug: string } }} props
 */
export default async function LibraryEntryPage(props) {
  const {
    params
  } = props;
  return __litsxScopedTemplate(html`<page-frame eyebrow="Prerendered dynamic static route" title="${`${params.category} / ${params.slug}`}">Selected params are materialized during build, while unlisted ones still fall back to runtime rendering and cache population.</page-frame>`, {
    "page-frame": PageFrame
  });
}
LibraryEntryPage[LITSX_SERVER_COMPONENT] = true;