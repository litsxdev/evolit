import { html } from "lit";
import { __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from "@litsx/core/elements";
// @ts-nocheck
import { cookies, headers, notFound, redirect, requestUrl, responseHeaders } from "nextsx/server";
import PageFrame from "../components/page-frame.mjs?t=1784926512597";
export default async function RequestContextPage({
  searchParams
}) {
  if (searchParams.missing === "1") {
    notFound();
  }
  if (searchParams.redirect === "1") {
    redirect("/blog/hello-world");
  }
  if (searchParams.error === "1") {
    throw new Error("Showcase error boundary");
  }
  const url = requestUrl();
  const requestHeaders = headers();
  const requestCookies = cookies();
  const visits = Number(requestCookies.get("nextsx-showcase-visits")?.value ?? "0") + 1;
  requestCookies.set("nextsx-showcase-visits", String(visits), {
    httpOnly: true,
    sameSite: "Lax"
  });
  responseHeaders().set("x-nextsx-showcase-context", "active");
  return __litsxScopedTemplate(html`<page-frame eyebrow="Request context" title="Headers, cookies, redirects"><p>Pathname: <strong>${url.pathname}</strong></p><p>Visits stored in an HTTP-only cookie: <strong>${String(visits)}</strong></p><p>User agent: <strong>${requestHeaders.get("user-agent") ?? "not provided"}</strong></p><p><a href="/request-context?redirect=1">Test redirect</a></p><p><a href="/request-context?missing=1">Test not found</a></p><p><a href="/request-context?error=1">Test error boundary</a></p></page-frame>`, {
    "page-frame": PageFrame
  });
}
RequestContextPage[LITSX_SERVER_COMPONENT] = true;