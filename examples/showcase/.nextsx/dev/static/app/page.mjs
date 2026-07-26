import { html } from '/_nextsx/shared/lit.mjs';
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements.mjs';
import HomeHero from './components/home-hero.mjs';
import RouteCard from './components/route-card.mjs';
import ShowcaseBadge from './components/showcase-badge.mjs';
import '/_nextsx/shared/litsx__core.mjs';

async function HomePage() {
  return __litsxScopedTemplate(html`<home-hero><div slot="intro"><showcase-badge label="Hydration + CSS asset + SVG asset"></showcase-badge><p class="eyebrow">Standalone validation target</p><h1 class="title">Probe the framework<br>like a consumer would.</h1><p class="copy">This example app is the manual check for file routing, assets, dynamic params, prerendered dynamic routes, and stale-while-revalidate caching under the normal<code> build/start </code>flow.</p></div><route-card title="Dynamic Route" body="/blog/[slug] renders params directly from the request pathname." href="/blog/hello-world" cache="dynamic"></route-card><route-card title="Static Params" body="/library/[category]/[slug] prerenders selected params at build time and caches the rest on demand." href="/library/books/field-guide" cache="static"></route-card><route-card title="ISR Route" body="/news/[slug] uses revalidate: 60 and the runtime stale-while-revalidate path." href="/news/launch-week" cache="revalidate"></route-card><route-card title="Request Context" body="Reads headers and cookies, writes a response cookie/header, and exposes redirect and not-found control flow." href="/request-context" cache="dynamic"></route-card></home-hero>`, {
    "home-hero": HomeHero,
    "showcase-badge": ShowcaseBadge,
    "route-card": RouteCard
  });
}
HomePage[LITSX_SERVER_COMPONENT] = true;

export { HomePage as default };
//# sourceMappingURL=page.mjs.map
