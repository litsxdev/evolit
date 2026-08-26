// @ts-nocheck
import PageFrame from "./components/page-frame.jsx";

export const metadata = {
  title: "Application error | evolit Showcase",
};

export default async function ErrorPage({ error }) {
  return (
    <PageFrame eyebrow="500" title="The route could not be rendered.">
      <p>Error: <strong>{error instanceof Error ? error.message : "Unknown error"}</strong></p>
      <p><a href="/">Return to the showcase</a></p>
    </PageFrame>
  );
}
