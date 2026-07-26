import { html } from '/_nextsx/shared/lit-C-FzaC7s.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements-gEpUokq0.mjs';
import PageFrame from '../../../components/page-frame-ayh-CziY.mjs';
import '/_nextsx/shared/litsx__core-BKwHhaBh.mjs';

const routeConfig = {
  cache: "static"
};

/**
 * @param {{ params: { category: string } }} context
 */
async function generateStaticParams(context) {
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
async function LibraryEntryPage(props) {
  const {
    params
  } = props;
  return __litsxScopedTemplate(html`<page-frame eyebrow="Prerendered dynamic static route" title="${`${params.category} / ${params.slug}`}">Selected params are materialized during build, while unlisted ones still fall back to runtime rendering and cache population.</page-frame>`, {
    "page-frame": PageFrame
  });
}
LibraryEntryPage[LITSX_SERVER_COMPONENT] = true;

export { LibraryEntryPage as default, generateStaticParams, routeConfig };
//# sourceMappingURL=page-CNcEFE9N.mjs.map
