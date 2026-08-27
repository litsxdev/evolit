import FeatureCard from "@/app/components/feature-card";

export default async function HomePage() {
  return (
    <section>
      <div class="intro">
        <p class="eyebrow">LitSX application framework</p>
        <h1>
          Next.js ideas,
          <br />
          LitSX authored.
        </h1>
        <p class="summary">
          This starter proves the first framework contract: routes from <code>app/</code>,
          nested layouts, request-aware page modules, and server rendering for LitSX-authored
          UI.
        </p>
      </div>

      <div class="features">
        <FeatureCard
          title="File Routing"
          body="Every app/page.jsx becomes an addressable route, with dynamic segments reserved for the next iteration."
        />
        <FeatureCard
          title="SSR Boundary"
          body="The framework now renders route trees through @litsx/ssr while keeping the adapter boundary internal."
        />
        <FeatureCard
          title="Compiler Reuse"
          body="Authored .jsx source is compiled through the public @litsx/compiler facade instead of a parallel transform path."
        />
      </div>
    </section>
  );
}
