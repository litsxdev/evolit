import { renderBootstrap, renderDocument } from "@litsx/ssr";
import { createRouteSegmentPayload, renderRouteSegmentPayload } from "./route-segments.js";

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeHeadMarkup(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join("\n");
  }

  return typeof value === "string" ? value : "";
}

function renderDescriptionMarkup(description) {
  return description
    ? `<meta name="description" content="${escapeHtmlAttribute(description)}" />`
    : "";
}

function renderRouteHeadMarkup(markup) {
  return `<!--evolit:route-head:start-->${markup}<!--evolit:route-head:end-->`;
}

function normalizeDocumentAttributes(attributes) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return {};
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([name, value]) => name !== "lang" && /^[^\s"'>/=]+$/.test(name) && value !== false && value != null)
      .map(([name, value]) => [name, value === true ? true : String(value)]),
  );
}

function renderDocumentAttributes(attributes) {
  return Object.entries(normalizeDocumentAttributes(attributes))
    .map(([name, value]) => value === true ? name : `${name}="${escapeHtmlAttribute(value)}"`)
    .join(" ");
}

function createDocumentState(metadata) {
  return {
    lang: String(metadata.lang ?? "en"),
    htmlAttributes: normalizeDocumentAttributes(metadata.htmlAttributes),
    bodyAttributes: normalizeDocumentAttributes(metadata.bodyAttributes),
  };
}

function renderDocumentStateScript(metadata) {
  const serialized = JSON.stringify(createDocumentState(metadata))
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026");
  return `<script type="application/json" id="__EVOLIT_DOCUMENT__">${serialized}</script>`;
}

function resolveDocumentMetadata(routeMetadata = {}, adapterOptions = {}) {
  const description =
    routeMetadata.description ?? adapterOptions.description ?? "A LitSX application";
  const extraHead = [
    renderDescriptionMarkup(description),
    normalizeHeadMarkup(adapterOptions.head),
    normalizeHeadMarkup(routeMetadata.head),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    lang: String(routeMetadata.lang ?? adapterOptions.lang ?? "en"),
    title: String(routeMetadata.title ?? adapterOptions.title ?? "evolit"),
    description: String(description),
    head: extraHead,
    htmlAttributes: {
      ...(adapterOptions.htmlAttributes ?? {}),
      ...(routeMetadata.htmlAttributes ?? {}),
    },
    bodyAttributes: {
      ...(adapterOptions.bodyAttributes ?? {}),
      ...(routeMetadata.bodyAttributes ?? {}),
    },
  };
}

function createHtmlDocument({ body, metadata = {} }) {
  const title = metadata.title ? String(metadata.title) : "evolit";
  const htmlAttributes = renderDocumentAttributes(metadata.htmlAttributes);
  const bodyAttributes = renderDocumentAttributes(metadata.bodyAttributes);

  return `<!DOCTYPE html>
<html lang="${escapeHtmlAttribute(metadata.lang ?? "en")}"${htmlAttributes ? ` ${htmlAttributes}` : ""}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
${metadata.head ? `    ${String(metadata.head).split("\n").join("\n    ")}` : ""}
  </head>
  <body${bodyAttributes ? ` ${bodyAttributes}` : ""}>${body}</body>
</html>`;
}

function createRouteHeaders(routeResult, headers = {}) {
  return {
    ...headers,
    ...(routeResult.responseHeaders ?? {}),
  };
}

function renderHydrationDataScript(hydrationData) {
  if (!hydrationData) return "";
  const serialized = JSON.stringify(hydrationData)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026");
  return `<script type="application/json" id="__LITSX_HYDRATION__">${serialized}</script>`;
}

function responseHeadersToObject(headers) {
  const values = Object.fromEntries(headers.entries());
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      values["set-cookie"] = cookies;
    }
  }
  return values;
}

export function createSsrAdapter(options = {}) {
  return {
    name: options.name ?? "litsx-ssr",
    async renderRouteTree(routeResult) {
      if (routeResult.type === "handler") {
        return {
          status: routeResult.response.status,
          headers: responseHeadersToObject(routeResult.response.headers),
          body: routeResult.response.body,
        };
      }

      if (routeResult.type === "not-found" && !routeResult.tree) {
        return {
          status: 404,
          headers: createRouteHeaders(routeResult, { "content-type": "text/html; charset=utf-8" }),
          body: "<!DOCTYPE html><html><body><h1>404</h1><p>Route not found.</p></body></html>",
        };
      }

      if (routeResult.type === "redirect") {
        return {
          status: routeResult.status ?? 307,
          headers: createRouteHeaders(routeResult, {
            location: routeResult.location,
            "content-type": "text/html; charset=utf-8",
          }),
          body: "<!DOCTYPE html><html><body><p>Redirecting...</p></body></html>",
        };
      }

      if (typeof routeResult.tree === "string" && routeResult.ssrArtifacts) {
        const result = routeResult.ssrArtifacts;
        if (typeof options.onSsrResult === "function") {
          await options.onSsrResult({ routeResult, result });
        }
        const metadata = resolveDocumentMetadata(routeResult.metadata, options);
        const generatedBootstrap =
          !options.bootstrap && !options.clientEntry && typeof options.resolveBootstrap === "function"
            ? await options.resolveBootstrap({ routeResult, result })
            : "";
        const additionalHead =
          typeof options.resolveAdditionalHead === "function"
            ? await options.resolveAdditionalHead({ routeResult, result })
            : "";
        // Adapter head is global. Route metadata and renderer-provided head
        // tags are delimited so browser navigation can replace only that part.
        const routeHead = [
          renderDescriptionMarkup(metadata.description),
          normalizeHeadMarkup(routeResult.metadata?.head),
          ...(result.headTags ?? []),
        ]
          .filter(Boolean)
          .join("\n");
        const composedHead = [
          normalizeHeadMarkup(options.head),
          renderRouteHeadMarkup(routeHead),
          additionalHead,
        ]
          .filter(Boolean)
          .join("\n");
        const document = createHtmlDocument({
          body: `${routeResult.tree}${renderHydrationDataScript(result.hydrationData)}`,
          metadata: {
            ...routeResult.metadata,
            ...metadata,
            head: composedHead,
          },
        });
        const transformedDocument =
          typeof options.transformDocument === "function"
            ? await options.transformDocument({ routeResult, result, document })
            : document;
        const routeRuntimeScripts = [
          renderRouteSegmentPayload(createRouteSegmentPayload(routeResult)),
          renderDocumentStateScript(metadata),
        ].filter(Boolean).join("\n");
        const documentWithRouteSegments = routeRuntimeScripts
          ? transformedDocument.replace("</body>", `${routeRuntimeScripts}\n</body>`)
          : transformedDocument;
        const body = generatedBootstrap
          ? documentWithRouteSegments.replace(
            "</body>",
            `${renderBootstrap({ bootstrap: { content: generatedBootstrap } })}\n</body>`,
          )
          : documentWithRouteSegments;

        return {
          status: routeResult.status ?? 200,
          headers: createRouteHeaders(routeResult, { "content-type": "text/html; charset=utf-8" }),
          body,
        };
      }

      if (typeof routeResult.tree === "string") {
        const metadata = resolveDocumentMetadata(routeResult.metadata, options);
        return {
          status: routeResult.status ?? 200,
          headers: createRouteHeaders(routeResult, { "content-type": "text/html; charset=utf-8" }),
          body: createHtmlDocument({
            body: routeResult.tree,
            metadata: {
              ...routeResult.metadata,
              ...metadata,
            },
          }),
        };
      }

      const documentOptions = resolveDocumentMetadata(routeResult.metadata, options);
      const bootstrap = options.bootstrap ?? false;
      const result = await renderDocument(routeResult.tree, {
        ...documentOptions,
        assetResolver: options.assetResolver,
        bootstrap,
        clientEntry: options.clientEntry,
        template: options.template,
      });
      if (typeof options.onSsrResult === "function") {
        await options.onSsrResult({ routeResult, result });
      }

      const generatedBootstrap =
        !options.bootstrap && !options.clientEntry && typeof options.resolveBootstrap === "function"
          ? await options.resolveBootstrap({ routeResult, result })
          : "";
      const additionalHead =
        typeof options.resolveAdditionalHead === "function"
          ? await options.resolveAdditionalHead({ routeResult, result })
          : "";
      const documentWithAdditionalHead = additionalHead
        ? result.document.replace("</head>", `${additionalHead}\n</head>`)
        : result.document;
      const transformedDocument =
        typeof options.transformDocument === "function"
          ? await options.transformDocument({
            routeResult,
            result,
            document: documentWithAdditionalHead,
          })
          : documentWithAdditionalHead;
      const routeRuntimeScripts = [
        renderRouteSegmentPayload(createRouteSegmentPayload(routeResult)),
        renderDocumentStateScript(documentOptions),
      ].filter(Boolean).join("\n");
      const documentWithRouteSegments = routeRuntimeScripts
        ? transformedDocument.replace("</body>", `${routeRuntimeScripts}\n</body>`)
        : transformedDocument;

      if (generatedBootstrap) {
        const bootstrapMarkup = renderBootstrap({
          bootstrap: {
            content: generatedBootstrap,
          },
        });
        const documentWithBootstrap = documentWithRouteSegments.replace(
          "</body>",
          `${bootstrapMarkup}\n</body>`,
        );

        return {
          status: routeResult.status ?? 200,
          headers: createRouteHeaders(routeResult, { "content-type": "text/html; charset=utf-8" }),
          body: documentWithBootstrap,
        };
      }

      return {
        status: routeResult.status ?? 200,
        headers: createRouteHeaders(routeResult, { "content-type": "text/html; charset=utf-8" }),
        body: documentWithRouteSegments,
      };
    },
  };
}

export async function renderRouteTreeWithAdapter(routeResult, adapter = createSsrAdapter()) {
  return adapter.renderRouteTree(routeResult);
}
