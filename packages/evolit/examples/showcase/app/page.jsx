// @ts-nocheck
import HomeHero from "./components/home-hero.jsx";
import RouteCard from "./components/route-card.jsx";
import ShowcaseBadge from "./components/showcase-badge.jsx";

export default async function HomePage() {
  return (
    <HomeHero>
      <div slot="intro">
        <ShowcaseBadge label="Hydration + CSS asset + SVG asset" />
        <p class="eyebrow">Standalone validation target</p>
        <h1 class="title">
          Probe the framework
          <br />
          like a consumer would.
        </h1>
        <p class="copy">
          This example app is the manual check for file routing, assets, dynamic params,
          prerendered dynamic routes, and stale-while-revalidate caching under the normal
          <code> build/start </code>
          flow.
        </p>
      </div>
      <RouteCard
        title="Dynamic Route"
        body="/blog/[slug] renders params directly from the request pathname."
        href="/blog/hello-world"
        cache="dynamic"
      />
      <RouteCard
        title="Static Params"
        body="/library/[category]/[slug] prerenders selected params at build time and caches the rest on demand."
        href="/library/books/field-guide"
        cache="static"
      />
      <RouteCard
        title="ISR Route"
        body="/news/[slug] uses revalidate: 60 and the runtime stale-while-revalidate path."
        href="/news/launch-week"
        cache="revalidate"
      />
      <RouteCard
        title="Request Context"
        body="Reads headers and cookies, writes a response cookie/header, and exposes redirect and not-found control flow."
        href="/request-context"
        cache="dynamic"
      />
      <RouteCard
        title="Route Handler"
        body="/api/status is a Web Response endpoint with no HTML response cache."
        href="/api/status"
        cache="dynamic"
      />
    </HomeHero>
  );
}
