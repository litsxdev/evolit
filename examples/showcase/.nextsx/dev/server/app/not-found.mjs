import { html } from "lit";
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from "@litsx/core/elements";
// @ts-nocheck
import PageFrame from "./components/page-frame.mjs?t=1784926512758";
export const metadata = {
  title: "Page not found | nextsx Showcase"
};
export default async function NotFoundPage() {
  return __litsxScopedTemplate(html`<page-frame eyebrow="404" title="This route does not exist."><p><a href="/">Return to the showcase</a></p></page-frame>`, {
    "page-frame": PageFrame
  });
}
NotFoundPage[LITSX_SERVER_COMPONENT] = true;