import { html } from "lit";
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from "@litsx/core/elements";
// @ts-nocheck
import PageFrame from "./components/page-frame.mjs";
export const metadata = {
  title: "Application error | nextsx Showcase"
};
export default async function ErrorPage({
  error
}) {
  return __litsxScopedTemplate(html`<page-frame eyebrow="500" title="The route could not be rendered."><p>Error: <strong>${error instanceof Error ? error.message : "Unknown error"}</strong></p><p><a href="/">Return to the showcase</a></p></page-frame>`, {
    "page-frame": PageFrame
  });
}
ErrorPage[LITSX_SERVER_COMPONENT] = true;