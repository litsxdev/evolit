// @ts-nocheck
import PageFrame from "./components/page-frame.jsx";

export const metadata = {
  title: "Page not found | evolit Showcase",
};

export default async function NotFoundPage() {
  return (
    <PageFrame eyebrow="404" title="This route does not exist.">
      <p><a href="/">Return to the showcase</a></p>
    </PageFrame>
  );
}
