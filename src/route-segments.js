import crypto from "node:crypto";
import path from "node:path";
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

const SEGMENT_MARKER_PREFIX = "evolit:segment";
const SEGMENT_MARKER_PATTERN = /<!--evolit:segment:(start|end):([A-Za-z0-9_-]+)-->/g;

function normalizeModulePath(projectRoot, modulePath) {
  return path.relative(projectRoot, modulePath).split(path.sep).join("/");
}

function createSegmentId(kind, modulePath, projectRoot) {
  const relativeModulePath = normalizeModulePath(projectRoot, modulePath);
  const digest = crypto
    .createHash("sha256")
    .update(`${kind}:${relativeModulePath}`)
    .digest("base64url")
    .slice(0, 12);

  return `${kind}-${digest}`;
}

export function createRouteSegmentPlan(route, projectRoot, options = {}) {
  const layouts = Array.isArray(route?.layouts) ? route.layouts : [];
  const segments = layouts.map((modulePath, index) => ({
    id: createSegmentId("layout", modulePath, projectRoot),
    kind: "layout",
    depth: index,
    modulePath: normalizeModulePath(projectRoot, modulePath),
  }));

  if (typeof route?.page === "string") {
    segments.push({
      id: createSegmentId("page", route.page, projectRoot),
      kind: "page",
      depth: segments.length,
      modulePath: normalizeModulePath(projectRoot, route.page),
    });
  } else if (typeof options.boundaryModule === "string") {
    segments.push({
      id: createSegmentId("boundary", options.boundaryModule, projectRoot),
      kind: "boundary",
      depth: segments.length,
      modulePath: normalizeModulePath(projectRoot, options.boundaryModule),
    });
  }

  return segments;
}

export function wrapRouteSegment(segment, value) {
  if (!segment?.id) {
    return value;
  }

  const startMarker = `<!--${SEGMENT_MARKER_PREFIX}:start:${segment.id}-->`;
  const endMarker = `<!--${SEGMENT_MARKER_PREFIX}:end:${segment.id}-->`;
  if (typeof value === "string") {
    return `${startMarker}${value}${endMarker}`;
  }

  return html`${unsafeHTML(startMarker)}${value}${unsafeHTML(endMarker)}`;
}

export function createRouteSegmentPayload(routeResult) {
  const segments = Array.isArray(routeResult?.segments) ? routeResult.segments : [];
  if (segments.length === 0) {
    return null;
  }

  return {
    version: 1,
    url: routeResult.cacheKey ?? routeResult.route?.pathname ?? null,
    pathname: routeResult.cacheKey?.split("?")[0] ?? routeResult.route?.pathname ?? null,
    cachePolicy: routeResult.cachePolicy
      ? {
        mode: routeResult.cachePolicy.mode,
        ...(routeResult.cachePolicy.mode === "revalidate"
          ? { ttlSeconds: routeResult.cachePolicy.ttlSeconds }
          : {}),
      }
      : null,
    segments: segments.map(({ id, kind, depth, modulePath, inputKey }) => ({
      id,
      kind,
      depth,
      modulePath,
      ...(typeof inputKey === "string" ? { inputKey } : {}),
    })),
  };
}

export function renderRouteSegmentPayload(payload, scriptId = "__EVOLIT_ROUTE__") {
  if (!payload) {
    return "";
  }

  const serialized = JSON.stringify(payload)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026");
  return `<script type="application/json" id="${scriptId}">${serialized}</script>`;
}

/**
 * Extracts every rendered projection of every route segment from a composed
 * SSR document. The marker protocol belongs to Evolit; LitSX only renders the
 * values that contain the markers.
 */
export function extractRouteSegmentArtifacts(documentHtml) {
  if (typeof documentHtml !== "string" || documentHtml.length === 0) {
    return new Map();
  }

  const artifacts = new Map();
  const openSegments = [];
  SEGMENT_MARKER_PATTERN.lastIndex = 0;

  for (const match of documentHtml.matchAll(SEGMENT_MARKER_PATTERN)) {
    const [marker, boundary, segmentId] = match;
    const markerStart = match.index ?? 0;
    const markerEnd = markerStart + marker.length;

    if (boundary === "start") {
      openSegments.push({ segmentId, contentStart: markerEnd });
      continue;
    }

    const openIndex = openSegments.map((entry) => entry.segmentId).lastIndexOf(segmentId);
    if (openIndex < 0) {
      continue;
    }

    const [{ contentStart }] = openSegments.splice(openIndex, 1);
    const projections = artifacts.get(segmentId) ?? [];
    projections.push({
      projectionId: `${segmentId}:${projections.length}`,
      html: documentHtml.slice(contentStart, markerStart),
    });
    artifacts.set(segmentId, projections);
  }

  return artifacts;
}

export function createRouteSegmentDelta(routeResult, documentHtml) {
  const payload = createRouteSegmentPayload(routeResult);
  if (!payload) {
    return null;
  }

  const artifacts = extractRouteSegmentArtifacts(documentHtml);
  return {
    ...payload,
    segments: payload.segments.map((segment) => ({
      ...segment,
      projections: artifacts.get(segment.id) ?? [],
    })),
  };
}

export function createNavigationResponseFromDocument(response) {
  if (response?.headers?.location && response.status >= 300 && response.status < 400) {
    return {
      ...response,
      headers: {
        ...(response.headers ?? {}),
        "content-type": "application/vnd.evolit.navigation+json; charset=utf-8",
        "cache-control": "no-store",
        vary: appendVaryHeader(response.headers?.vary, "accept"),
      },
      body: JSON.stringify({
        version: 1,
        type: "redirect",
        location: response.headers.location,
      }),
    };
  }

  if (typeof response?.body !== "string") {
    return response;
  }

  const routeMatch = response.body.match(
    /<script type="application\/json" id="__EVOLIT_ROUTE__">([\s\S]*?)<\/script>/,
  );
  if (!routeMatch) {
    return response;
  }

  let route;
  try {
    route = JSON.parse(routeMatch[1]);
  } catch {
    return response;
  }

  const artifacts = extractRouteSegmentArtifacts(response.body);
  const hydrationMatch = response.body.match(
    /<script type="application\/json" id="__LITSX_HYDRATION__">([\s\S]*?)<\/script>/,
  );
  const titleMatch = response.body.match(/<title>([\s\S]*?)<\/title>/i);
  const head = extractRouteHeadMarkup(response.body);
  const documentState = extractDocumentState(response.body);
  const headAssets = extractRouteHeadAssets(response.body);
  const body = JSON.stringify({
    version: 1,
    type: "route",
    url: route.url,
    route: {
      ...route,
      segments: route.segments.map((segment) => ({
        ...segment,
        projections: artifacts.get(segment.id) ?? [],
      })),
    },
    ...(titleMatch ? { title: titleMatch[1] } : {}),
    ...(head != null ? { head } : {}),
    ...(documentState ? { document: documentState } : {}),
    headAssets,
    ...(hydrationMatch ? { hydrationData: JSON.parse(hydrationMatch[1]) } : {}),
  });

  return {
    ...response,
    headers: {
      ...(response.headers ?? {}),
      "content-type": "application/vnd.evolit.navigation+json; charset=utf-8",
      "cache-control": "no-store",
      vary: appendVaryHeader(response.headers?.vary, "accept"),
    },
    body,
  };
}

export function extractDocumentState(documentHtml) {
  if (typeof documentHtml !== "string") return null;
  const match = documentHtml.match(/<script type="application\/json" id="__EVOLIT_DOCUMENT__">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

export function extractRouteHeadMarkup(documentHtml) {
  if (typeof documentHtml !== "string") return null;
  const match = documentHtml.match(/<!--evolit:route-head:start-->([\s\S]*?)<!--evolit:route-head:end-->/i);
  return match?.[1] ?? null;
}

export function extractRouteHeadAssets(documentHtml) {
  const assets = { styles: [], preloads: [] };
  if (typeof documentHtml !== "string") return assets;

  for (const match of documentHtml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const kind = tag.match(/\bdata-evolit-route-asset="([^"]+)"/i)?.[1];
    const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
    if (!href) continue;
    if (kind === "style") assets.styles.push(href);
    if (kind === "preload") assets.preloads.push(href);
  }

  return assets;
}

function appendVaryHeader(value, field) {
  const fields = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!fields.some((item) => item.toLowerCase() === field.toLowerCase())) fields.push(field);
  return fields.join(", ");
}
