import { useHost, useOnConnect, useState } from "@litsx/core";
import {
  applyHydrationPayload,
  hydrateRoot,
  prepareHydrationResources,
  registerHydrationModules,
} from "@litsx/ssr/hydration";
import { createHref } from "./navigation-url.js";

export { createHref } from "./navigation-url.js";

let browserNavigation = null;
let nextHistoryEntryId = 0;
const DEVELOPMENT_REFRESH_EVENT = "evolit:development-refresh";
const historySessionId = globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function readRoute(documentRef) {
  const source = documentRef.getElementById("__EVOLIT_ROUTE__")?.textContent;
  try { return source ? JSON.parse(source) : null; } catch { return null; }
}

function readRouteParams(documentRef) {
  const params = readRoute(documentRef)?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return Object.freeze({});
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? Object.freeze([...value]) : value,
    ]),
  ));
}

function findMarkers(root, segmentId, matches = []) {
  const documentRef = root.ownerDocument ?? root;
  const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const open = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.data === `evolit:segment:start:${segmentId}`) open.push(node);
    if (node.data === `evolit:segment:end:${segmentId}` && open.length > 0) matches.push({ start: open.pop(), end: node });
  }
  for (const element of root.querySelectorAll?.("*") ?? []) {
    if (element.shadowRoot) findMarkers(element.shadowRoot, segmentId, matches);
  }
  return matches;
}

function materializeDeclarativeShadowDom(root) {
  for (const template of [...root.querySelectorAll?.("template[shadowrootmode],template[shadowroot]") ?? []]) {
    const host = template.parentElement;
    if (!host || host.shadowRoot) continue;
    const mode = template.getAttribute("shadowrootmode") ?? template.getAttribute("shadowroot") ?? "open";
    const shadowRoot = host.attachShadow({ mode });
    shadowRoot.append(template.content);
    template.remove();
    materializeDeclarativeShadowDom(shadowRoot);
  }
}

function findHydrationElement(root, rootId) {
  const selector = `[data-litsx-root="${CSS.escape(rootId)}"]`;
  const direct = root.querySelector?.(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll?.("*") ?? []) {
    if (element.shadowRoot) {
      const match = findHydrationElement(element.shadowRoot, rootId);
      if (match) return match;
    }
  }
  return null;
}

function loadStyleSheet(documentRef, href) {
  const existing = documentRef.head.querySelector(`link[data-evolit-route-asset="style"][href="${CSS.escape(href)}"]`);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const link = documentRef.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.evolitRouteAsset = "style";
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => resolve(link), { once: true });
    documentRef.head.append(link);
  });
}

async function syncRouteHeadAssets(headAssets, documentRef) {
  if (!headAssets) return;
  const styles = [...new Set(headAssets.styles ?? [])];
  const preloads = [...new Set(headAssets.preloads ?? [])];
  await Promise.all(styles.map((href) => loadStyleSheet(documentRef, href)));

  for (const href of preloads) {
    const selector = `link[data-evolit-route-asset="preload"][href="${CSS.escape(href)}"]`;
    if (documentRef.head.querySelector(selector)) continue;
    const link = documentRef.createElement("link");
    link.rel = "modulepreload";
    link.href = href;
    link.dataset.evolitRouteAsset = "preload";
    documentRef.head.append(link);
  }

  const expected = new Set([
    ...styles.map((href) => `style:${href}`),
    ...preloads.map((href) => `preload:${href}`),
  ]);
  for (const link of documentRef.head.querySelectorAll("link[data-evolit-route-asset]")) {
    const key = `${link.dataset.evolitRouteAsset}:${link.getAttribute("href")}`;
    if (!expected.has(key)) link.remove();
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Navigation was superseded.", "AbortError");
  }
}

function findRouteHeadMarkers(documentRef) {
  const walker = documentRef.createTreeWalker(documentRef.head, NodeFilter.SHOW_COMMENT);
  let start = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.data === "evolit:route-head:start") start = node;
    if (node.data === "evolit:route-head:end" && start) return { start, end: node };
  }
  return null;
}

function syncRouteHeadMarkup(markup, documentRef) {
  if (typeof markup !== "string") return;
  const markers = findRouteHeadMarkers(documentRef);
  if (!markers) return;
  const template = documentRef.createElement("template");
  template.innerHTML = markup;
  const range = documentRef.createRange();
  range.setStartAfter(markers.start);
  range.setEndBefore(markers.end);
  range.deleteContents();
  range.insertNode(template.content);
}

function normalizeManagedAttributes(attributes) {
  return attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes : {};
}

function readDocumentState(documentRef) {
  const source = documentRef.getElementById("__EVOLIT_DOCUMENT__")?.textContent;
  try { return source ? JSON.parse(source) : null; } catch { return null; }
}

function syncElementAttributes(element, previousAttributes, nextAttributes) {
  const previous = normalizeManagedAttributes(previousAttributes);
  const next = normalizeManagedAttributes(nextAttributes);
  for (const name of Object.keys(previous)) {
    if (!(name in next)) element.removeAttribute(name);
  }
  for (const [name, value] of Object.entries(next)) {
    if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
}

function syncDocumentState(nextState, documentRef) {
  if (!nextState || typeof nextState !== "object") return;
  const previous = readDocumentState(documentRef) ?? {};
  syncElementAttributes(documentRef.documentElement, previous.htmlAttributes, nextState.htmlAttributes);
  syncElementAttributes(documentRef.body, previous.bodyAttributes, nextState.bodyAttributes);
  if (typeof nextState.lang === "string") documentRef.documentElement.lang = nextState.lang;
  const script = documentRef.getElementById("__EVOLIT_DOCUMENT__");
  if (script) script.textContent = JSON.stringify(nextState);
}

function versionClientImport(specifier, version) {
  if (!version || typeof specifier !== "string") return specifier;
  const url = new URL(specifier, globalThis.location?.href ?? "http://evolit.local/");
  url.searchParams.set("__evolit_hot", String(version));
  return url.origin === globalThis.location?.origin
    ? `${url.pathname}${url.search}${url.hash}`
    : url.href;
}

async function applyRouteDelta(delta, documentRef = document, signal, options = {}) {
  throwIfAborted(signal);
  prepareHydrationResources(delta.hydrationData);
  const current = readRoute(documentRef);
  const nextSegments = delta.route?.segments ?? [];
  const currentSegments = current?.segments ?? [];
  let index = nextSegments.findIndex((segment, offset) => segment.id !== currentSegments[offset]?.id);
  if (index < 0) {
    index = nextSegments.findIndex(
      (segment, offset) => segment.inputKey !== currentSegments[offset]?.inputKey,
    );
  }
  if (index < 0) {
    index = nextSegments.findIndex(
      (segment, offset) => segment.revision !== currentSegments[offset]?.revision,
    );
  }
  if (index < 0 && options.requireSegmentChange === true) return true;
  if (index < 0) index = Math.max(0, nextSegments.length - 1);
  let next;
  let previous;
  let targets;
  // A leaf rendered as plain text can have no physical segment markers: Lit
  // escapes those markers inside its parent template. Walk outward to the
  // nearest replaceable ancestor rather than treating a zero/zero match as a
  // successful update. This also recovers safely from stale child cardinality.
  for (let candidate = index; candidate >= 0; candidate -= 1) {
    const candidateNext = nextSegments[candidate];
    const candidatePrevious = currentSegments[candidate] ?? currentSegments.at(-1);
    if (!candidateNext || !candidatePrevious) continue;
    const candidateTargets = findMarkers(documentRef, candidatePrevious.id);
    if (
      candidateTargets.length > 0
      && candidateTargets.length === candidateNext.projections.length
    ) {
      next = candidateNext;
      previous = candidatePrevious;
      targets = candidateTargets;
      break;
    }
  }
  if (!next || !previous || !targets) return false;
  await syncRouteHeadAssets(delta.headAssets, documentRef);
  throwIfAborted(signal);
  const clientImports = (delta.hydrationData?.clientImports ?? [])
    .map((specifier) => versionClientImport(specifier, options.moduleVersion));
  await registerHydrationModules(
    await Promise.all(clientImports.map((specifier) => import(specifier))),
  );
  throwIfAborted(signal);
  syncRouteHeadMarkup(delta.head, documentRef);
  syncDocumentState(delta.document, documentRef);
  const insertedRoots = [];
  for (const [offset, target] of targets.entries()) {
    throwIfAborted(signal);
    const projection = next.projections[offset] ?? next.projections[0];
    if (!projection) continue;
    const template = documentRef.createElement("template");
    template.innerHTML = projection.html;
    const fragment = template.content;
    materializeDeclarativeShadowDom(fragment);
    const roots = (delta.hydrationData?.roots ?? []).map((root) => ({
      root,
      element: findHydrationElement(fragment, root.id),
    })).filter((entry) => entry.element);
    // A custom element already defined by an earlier route is upgraded as
    // soon as this fragment is connected. Apply its SSR data while it is
    // still detached, otherwise Lit starts an update against its declarative
    // shadow root without the properties used to render it on the server.
    applyHydrationPayload(
      roots.map(({ root, element }) => ({ ...root, element })),
      delta.hydrationData,
    );
    const range = documentRef.createRange();
    range.setStartAfter(target.start);
    range.setEndBefore(target.end);
    range.deleteContents();
    range.insertNode(fragment);
    insertedRoots.push(...roots);
    target.start.data = `evolit:segment:start:${next.id}`;
    target.end.data = `evolit:segment:end:${next.id}`;
  }
  const script = documentRef.getElementById("__EVOLIT_ROUTE__");
  if (script) script.textContent = JSON.stringify(delta.route);
  if (delta.title) documentRef.title = delta.title;
  for (const { root, element } of insertedRoots) {
    throwIfAborted(signal);
    await hydrateRoot(element, {
      rootId: root.id,
      hydrationData: delta.hydrationData,
      clientImports,
    });
  }
  return true;
}

function toHref(target, location) {
  return new URL(target, location.href).href;
}

function toCacheKey(href) {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

function getDeltaExpiry(delta, now = Date.now()) {
  const policy = delta?.route?.cachePolicy;
  if (!policy || policy.mode === "dynamic") return null;
  if (policy.mode === "static") return Number.POSITIVE_INFINITY;
  if (policy.mode === "revalidate" && Number.isFinite(policy.ttlSeconds)) {
    return now + (policy.ttlSeconds * 1_000);
  }
  return null;
}

function isNavigationResponse(response) {
  return response.headers?.get("content-type")?.includes("application/vnd.evolit.navigation+json");
}

function shouldInterceptGetForm(event, windowRef) {
  const form = event.target;
  const submitter = event.submitter;
  if (
    event.defaultPrevented
    || form?.tagName?.toLowerCase?.() !== "form"
    || form.dataset?.evolitNavigation === "false"
    || submitter?.dataset?.evolitNavigation === "false"
  ) return false;

  const method = String(submitter?.formMethod || form.method || "get").toLowerCase();
  const target = submitter?.formTarget || form.target;
  if (method !== "get" || (target && target !== "_self")) return false;
  if (form.querySelector?.('input[type="file"]')) return false;

  const action = submitter?.formAction || form.action || windowRef.location.href;
  return new URL(action, windowRef.location.href).origin === windowRef.location.origin;
}

function createGetFormTarget(form, submitter, windowRef) {
  const action = submitter?.formAction || form.action || windowRef.location.href;
  const target = new URL(action, windowRef.location.href);
  const data = new FormData(form, submitter);
  const searchParams = new URLSearchParams();
  for (const [name, value] of data) {
    // File inputs are excluded before interception. Keep this defensive guard
    // so an unusual FormData implementation cannot serialize a file as text.
    if (typeof value !== "string") return null;
    searchParams.append(name, value);
  }
  target.search = searchParams;
  return target.href;
}

function currentScrollPosition(windowRef) {
  return {
    x: Number.isFinite(windowRef.scrollX) ? windowRef.scrollX : 0,
    y: Number.isFinite(windowRef.scrollY) ? windowRef.scrollY : 0,
  };
}

function findHashTarget(documentRef, href) {
  const hash = new URL(href).hash.slice(1);
  if (!hash) return null;
  try {
    return documentRef.getElementById(decodeURIComponent(hash))
      ?? documentRef.querySelector(`[name="${CSS.escape(decodeURIComponent(hash))}"]`);
  } catch {
    return null;
  }
}

function restoreScrollAndFocus(windowRef, href, position, preserveScroll = false) {
  if (!preserveScroll) {
    const target = findHashTarget(windowRef.document, href);
    if (target?.scrollIntoView) {
      target.scrollIntoView();
    } else if (position) {
      windowRef.scrollTo?.(position.x, position.y);
    } else {
      windowRef.scrollTo?.(0, 0);
    }
  }

  const main = windowRef.document.querySelector?.("main");
  if (main?.focus) {
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus({ preventScroll: true });
  }
}

export function createBrowserNavigation(options = {}) {
  const windowRef = options.window ?? globalThis.window;
  if (!windowRef?.history || !windowRef?.fetch) {
    throw new Error("Browser navigation is only available in a browser context.");
  }

  const listeners = new Set();
  const historyEntries = new Map();
  let controller = null;
  let navigationSequence = 0;
  let state = { status: "idle", url: windowRef.location.href, pendingUrl: null, error: null };
  const emit = () => listeners.forEach((listener) => listener(state));
  const notifyLocationChange = () => {
    const EventConstructor = windowRef.CustomEvent ?? globalThis.CustomEvent;
    if (typeof windowRef.dispatchEvent === "function" && typeof EventConstructor === "function") {
      windowRef.dispatchEvent(new EventConstructor("evolit:navigation", { detail: state }));
    }
  };
  const applyDelta = options.applyDelta
    ?? ((delta, context = {}) => applyRouteDelta(
      delta,
      windowRef.document,
      context.signal,
      context,
    ));

  function navigateDocument(href, mode) {
    // This is deliberately a fallback, not the normal navigation path. It
    // preserves correctness for responses that cannot be represented as an
    // Evolit route delta (404s, external adapters, malformed payloads, ...).
    if (mode === "replace") windowRef.location.replace(href);
    else windowRef.location.assign(href);
  }

  function saveCurrentScrollPosition() {
    windowRef.history.replaceState(
      { ...(windowRef.history.state ?? {}), __evolitScroll: currentScrollPosition(windowRef) },
      "",
      windowRef.location.href,
    );
  }

  function createHistoryEntryId() {
    nextHistoryEntryId += 1;
    return `evolit-${historySessionId}-${nextHistoryEntryId}`;
  }

  function ensureHistoryEntry(entryId = windowRef.history.state?.__evolitNavigationEntry) {
    const id = typeof entryId === "string" ? entryId : createHistoryEntryId();
    if (!historyEntries.has(id)) historyEntries.set(id, { parentId: null, url: null, delta: null, expiresAt: null });
    if (windowRef.history.state?.__evolitNavigationEntry !== id) {
      windowRef.history.replaceState(
        { ...(windowRef.history.state ?? {}), __evolitNavigationEntry: id },
        "",
        windowRef.location.href,
      );
    }
    return id;
  }

  function removeForwardHistoryEntries(currentEntryId) {
    const retained = new Set();
    let entryId = currentEntryId;
    while (entryId && !retained.has(entryId)) {
      retained.add(entryId);
      entryId = historyEntries.get(entryId)?.parentId ?? null;
    }
    for (const id of historyEntries.keys()) {
      if (!retained.has(id)) historyEntries.delete(id);
    }
  }

  function getCachedDelta(entryId, cacheKey, force) {
    if (force) return null;
    const entry = historyEntries.get(entryId);
    if (!entry || entry.url !== cacheKey || entry.expiresAt == null || entry.expiresAt <= Date.now()) {
      if (entry?.expiresAt != null && entry.expiresAt <= Date.now()) entry.delta = null;
      return null;
    }
    return entry.delta;
  }

  function cacheDelta(entryId, cacheKey, delta) {
    const expiresAt = getDeltaExpiry(delta);
    if (expiresAt == null) return;
    const entry = historyEntries.get(entryId);
    if (!entry) return;
    entry.url = cacheKey;
    entry.delta = delta;
    entry.expiresAt = expiresAt;
  }

  async function navigate(target, mode = "push", fromPopState = false, options = {}) {
    const href = toHref(target, windowRef.location);
    const cacheKey = toCacheKey(href);
    const scrollPosition = options.scroll === false
      ? currentScrollPosition(windowRef)
      : options.scrollPosition;
    controller?.abort();
    const navigationController = new AbortController();
    controller = navigationController;
    const navigationId = ++navigationSequence;
    const isCurrent = () => navigationId === navigationSequence && !navigationController.signal.aborted;
    const currentEntryId = ensureHistoryEntry();
    let entryId = options.historyEntryId;
    if (fromPopState) {
      entryId = ensureHistoryEntry(entryId);
    } else if (mode === "push") {
      saveCurrentScrollPosition();
      removeForwardHistoryEntries(currentEntryId);
      entryId = createHistoryEntryId();
      historyEntries.set(entryId, { parentId: currentEntryId, url: null, delta: null, expiresAt: null });
    } else {
      entryId = currentEntryId;
    }
    state = { ...state, status: "pending", pendingUrl: href, error: null };
    emit();
    try {
      const cached = getCachedDelta(entryId, cacheKey, options.force);
      const delta = cached
        ? cached
        : await (async () => {
          const response = await windowRef.fetch(href, {
            headers: { accept: "application/vnd.evolit.navigation+json" },
            // A document response may already be fresh in the browser HTTP cache.
            // Navigation is a different representation of that URL, so it must
            // reach the server rather than reusing the cached HTML document.
            cache: "no-store",
            signal: navigationController.signal,
            credentials: "same-origin",
          });
          if (!isNavigationResponse(response)) {
            navigateDocument(response.url || href, mode);
            return null;
          }
          let nextDelta;
          try {
            nextDelta = await response.json();
          } catch {
            navigateDocument(response.url || href, mode);
            return null;
          }
          if (nextDelta?.type !== "route" && nextDelta?.type !== "redirect") {
            navigateDocument(response.url || href, mode);
            return null;
          }
          if (!isCurrent()) return null;
          return nextDelta;
        })();
      if (!delta || !isCurrent()) return null;
      if (delta.type === "redirect") return navigate(delta.location, "replace", false);
      const applied = await applyDelta(delta, {
        signal: navigationController.signal,
        moduleVersion: options.moduleVersion,
        hot: options.hot,
      });
      if (applied === false) {
        navigateDocument(href, mode);
        return null;
      }
      if (!isCurrent()) return null;
      const canonicalHref = toHref(delta.url ?? href, windowRef.location);
      if (!fromPopState) {
        windowRef.history[mode === "replace" ? "replaceState" : "pushState"](
          {
            ...(mode === "replace" ? windowRef.history.state : {}),
            __evolitNavigationEntry: entryId,
            __evolitScroll: scrollPosition ?? { x: 0, y: 0 },
          },
          "",
          canonicalHref,
        );
      }
      cacheDelta(entryId, toCacheKey(canonicalHref), delta);
      restoreScrollAndFocus(
        windowRef,
        canonicalHref,
        scrollPosition,
        options.scroll === false,
      );
      state = { status: "idle", url: canonicalHref, pendingUrl: null, error: null };
      emit();
      notifyLocationChange();
      return delta;
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrent()) return null;
      state = { ...state, status: "error", pendingUrl: null, error };
      emit();
      throw error;
    }
  }

  windowRef.addEventListener("popstate", (event) => {
    void navigate(windowRef.location.href, "replace", true, {
      historyEntryId: event.state?.__evolitNavigationEntry,
      scrollPosition: event.state?.__evolitScroll ?? null,
    });
  });
  windowRef.addEventListener(DEVELOPMENT_REFRESH_EVENT, (event) => {
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return;
    detail.handled = true;
    if (detail.update?.type !== "update" || detail.update?.strategy === "reload") {
      detail.result = Promise.resolve(false);
      return;
    }
    controller?.abort();
    const refreshController = new AbortController();
    controller = refreshController;
    state = { ...state, status: "pending", pendingUrl: windowRef.location.href, error: null };
    emit();
    detail.result = applyDelta(detail.update.delta, {
      signal: refreshController.signal,
      hot: detail.update.strategy === "hot",
      moduleVersion: detail.update.version,
      requireSegmentChange: true,
    }).then((applied) => {
      if (applied === false || refreshController.signal.aborted) return false;
      state = { status: "idle", url: windowRef.location.href, pendingUrl: null, error: null };
      emit();
      return true;
    }).catch((error) => {
      if (error?.name !== "AbortError") {
        state = { ...state, status: "error", pendingUrl: null, error };
        emit();
      }
      throw error;
    });
  });
  windowRef.document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.target || anchor.hasAttribute("download") || anchor.dataset.evolitNavigation === "false") return;
    const target = new URL(anchor.href, windowRef.location.href);
    if (target.origin !== windowRef.location.origin) return;
    event.preventDefault();
    void navigate(target.href, "push");
  });
  windowRef.document.addEventListener("submit", (event) => {
    if (!shouldInterceptGetForm(event, windowRef)) return;
    const target = createGetFormTarget(event.target, event.submitter, windowRef);
    if (!target) return;
    event.preventDefault();
    void navigate(target, "push");
  });
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    push: (target, options) => navigate(target, "push", false, options),
    replace: (target, options) => navigate(target, "replace", false, options),
    refresh: (options) => navigate(windowRef.location.href, "replace", false, { ...options, force: true }),
    createHref,
  };
}

export function getNavigation() {
  browserNavigation ??= createBrowserNavigation();
  return browserNavigation;
}

export function useNavigation() {
  const navigation = getNavigation();
  const host = useHost();
  const [state, setState] = useState(host, () => navigation.getState());
  useOnConnect(host, () => navigation.subscribe(setState), [navigation]);
  return {
    ...state,
    push: navigation.push,
    replace: navigation.replace,
    refresh: navigation.refresh,
    createHref: navigation.createHref,
  };
}

/**
 * Returns the dynamic route parameters for the active client route.
 * The returned object is a read-only snapshot and updates after navigation.
 */
export function useParams() {
  useNavigation();
  return readRouteParams(globalThis.document);
}

/**
 * Returns a URLSearchParams snapshot for the active client route.
 * Mutating it is local only; use createHref() and navigation.push()/replace()
 * to update the URL.
 */
export function useSearchParams() {
  const navigation = useNavigation();
  return new URL(navigation.url).searchParams;
}
