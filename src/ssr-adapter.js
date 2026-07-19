import { renderDocument } from "@litsx/ssr";
import {
  createHydrationBootstrap,
} from "./client-assets.js";

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

function resolveDocumentMetadata(routeMetadata = {}, adapterOptions = {}) {
  const description =
    routeMetadata.description ?? adapterOptions.description ?? "A LitSX application";
  const extraHead = [
    description
      ? `<meta name="description" content="${escapeHtmlAttribute(description)}" />`
      : "",
    normalizeHeadMarkup(adapterOptions.head),
    normalizeHeadMarkup(routeMetadata.head),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    lang: String(routeMetadata.lang ?? adapterOptions.lang ?? "en"),
    title: String(routeMetadata.title ?? adapterOptions.title ?? "nextsx"),
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
  const title = metadata.title ? String(metadata.title) : "nextsx";
  const description =
    metadata.description ? String(metadata.description) : "A LitSX application";

  return `<!DOCTYPE html>
<html lang="${escapeHtmlAttribute(metadata.lang ?? "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>${description ? `
    <meta name="description" content="${escapeHtmlAttribute(description)}" />` : ""}
${metadata.head ? `    ${String(metadata.head).split("\n").join("\n    ")}` : ""}
  </head>
  <body>${body}</body>
</html>`;
}

export function createSsrAdapter(options = {}) {
  return {
    name: options.name ?? "litsx-ssr",
    async renderRouteTree(routeResult) {
      if (routeResult.type === "not-found") {
        return {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<!DOCTYPE html><html><body><h1>404</h1><p>Route not found.</p></body></html>",
        };
      }

      if (typeof routeResult.tree === "string") {
        const metadata = resolveDocumentMetadata(routeResult.metadata, options);
        return {
          status: routeResult.status ?? 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: createHtmlDocument({
            body: routeResult.tree,
            metadata: {
              ...routeResult.metadata,
              ...metadata,
              description: routeResult.metadata?.description ?? options.description,
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

      const rootModuleUrls = Object.fromEntries(
        (result.hydrationData?.roots ?? [])
          .filter((root) => typeof root?.moduleId === "string" && typeof root?.tagName === "string")
          .map((root) => [root.moduleId, options.assetResolver?.(root.moduleId) ?? null])
          .filter((entry) => typeof entry[1] === "string" && entry[1].length > 0),
      );

      if (Object.keys(rootModuleUrls).length > 0 && !options.bootstrap && !options.clientEntry) {
        const bootstrapContent = createHydrationBootstrap({ rootModuleUrls });
        const documentWithBootstrap = result.document.replace(
          "</body>",
          `<script type="module">\n${bootstrapContent}\n</script>\n</body>`,
        );

        return {
          status: routeResult.status ?? 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: documentWithBootstrap,
        };
      }

      return {
        status: routeResult.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: result.document,
      };
    },
  };
}

export async function renderRouteTreeWithAdapter(routeResult, adapter = createSsrAdapter()) {
  return adapter.renderRouteTree(routeResult);
}
