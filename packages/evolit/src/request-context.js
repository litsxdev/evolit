import { AsyncLocalStorage } from "node:async_hooks";

const REQUEST_CONTEXT_STORAGE = Symbol.for("evolit.request-context.storage");
const HTTP_SIGNAL_CLASS = Symbol.for("evolit.request-context.http-signal");

const requestContextStorage = globalThis[REQUEST_CONTEXT_STORAGE] ??= new AsyncLocalStorage();
const EvolitHttpSignal = globalThis[HTTP_SIGNAL_CLASS] ??= class EvolitHttpSignal extends Error {
  constructor(type, options = {}) {
    super(type);
    this.type = type;
    this.status = options.status;
    this.location = options.location;
  }
};

function getActiveContext() {
  const context = requestContextStorage.getStore();
  if (!context) {
    throw new Error("Request APIs can only be called while rendering a evolit route.");
  }

  return context;
}

function parseCookieHeader(value) {
  const values = new Map();
  if (typeof value !== "string" || value.length === 0) {
    return values;
  }

  for (const entry of value.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const name = entry.slice(0, separator).trim();
    if (!name) {
      continue;
    }

    values.set(name, decodeURIComponent(entry.slice(separator + 1).trim()));
  }

  return values;
}

function serializeCookie(name, value, options = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) attributes.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.domain) attributes.push(`Domain=${options.domain}`);
  attributes.push(`Path=${options.path ?? "/"}`);
  if (options.expires) attributes.push(`Expires=${new Date(options.expires).toUTCString()}`);
  if (options.httpOnly) attributes.push("HttpOnly");
  if (options.secure) attributes.push("Secure");
  if (options.sameSite) attributes.push(`SameSite=${options.sameSite}`);
  return attributes.join("; ");
}

function createCookieStore(context) {
  const requestCookies = parseCookieHeader(context.request.headers.get("cookie"));

  return Object.freeze({
    get(name) {
      const value = requestCookies.get(name);
      return value == null ? undefined : { name, value };
    },
    getAll(name) {
      if (name) {
        const cookie = this.get(name);
        return cookie ? [cookie] : [];
      }

      return [...requestCookies.entries()].map(([cookieName, value]) => ({ name: cookieName, value }));
    },
    has(name) {
      return requestCookies.has(name);
    },
    set(name, value, options = {}) {
      context.responseCookies.push(serializeCookie(name, String(value), options));
      requestCookies.set(name, String(value));
      context.didUseDynamicRequestData = true;
    },
    delete(name, options = {}) {
      context.responseCookies.push(serializeCookie(name, "", { ...options, maxAge: 0 }));
      requestCookies.delete(name);
      context.didUseDynamicRequestData = true;
    },
  });
}

function createRouteRequest(context) {
  return new Proxy(context.request, {
    get(target, property) {
      if (property !== "constructor" && property !== Symbol.toStringTag) {
        context.didUseDynamicRequestData = true;
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createRequestContext({
  request,
  params = {},
  searchParams = {},
  extensionValues = {},
  didUseDynamicRequestData = false,
}) {
  const context = {
    request,
    params: Object.freeze({ ...params }),
    searchParams: Object.freeze({ ...searchParams }),
    responseHeaders: new Headers(),
    responseCookies: [],
    didUseDynamicRequestData: didUseDynamicRequestData === true,
    extensionValues: Object.freeze({ ...extensionValues }),
  };
  context.cookieStore = createCookieStore(context);
  context.routeRequest = createRouteRequest(context);
  return context;
}

export function runWithRequestContext(context, callback) {
  return requestContextStorage.run(context, callback);
}

/**
 * Returns serializable values supplied by configured server extensions for
 * the active request. The object is isolated through AsyncLocalStorage and is
 * available only while a route or handler is executing.
 */
export function getRequestContext() {
  return getActiveContext().extensionValues;
}

/**
 * Returns the incoming request headers and marks the current route dynamic.
 *
 * @returns {Headers} The incoming request headers.
 */
export function headers() {
  const context = getActiveContext();
  context.didUseDynamicRequestData = true;
  return context.request.headers;
}

/**
 * Returns the request cookie store and marks the current route dynamic.
 * Mutations are merged into the outgoing response.
 *
 * @returns {object} A cookie store with `get`, `getAll`, `has`, `set`, and `delete`.
 */
export function cookies() {
  const context = getActiveContext();
  context.didUseDynamicRequestData = true;
  return context.cookieStore;
}

/**
 * Returns the incoming request URL and marks the current route dynamic.
 *
 * @returns {URL} The request URL.
 */
export function requestUrl() {
  const context = getActiveContext();
  context.didUseDynamicRequestData = true;
  return new URL(context.request.url);
}

/**
 * Returns mutable headers merged into the response after route rendering.
 *
 * @returns {Headers} Response headers.
 */
export function responseHeaders() {
  return getActiveContext().responseHeaders;
}

/**
 * Stops route execution and responds with a redirect.
 *
 * @param {string} location Redirect destination.
 * @param {number} [status=307] Redirect HTTP status.
 * @returns {never}
 */
export function redirect(location, status = 307) {
  throw new EvolitHttpSignal("redirect", { location: String(location), status });
}

/**
 * Stops route execution and responds with a permanent HTTP 308 redirect.
 *
 * @param {string} location Redirect destination.
 * @returns {never}
 */
export function permanentRedirect(location) {
  redirect(location, 308);
}

/**
 * Stops route execution with a 404 signal for the nearest `not-found.litsx` boundary.
 *
 * @returns {never}
 */
export function notFound() {
  throw new EvolitHttpSignal("not-found", { status: 404 });
}

export function isEvolitHttpSignal(error) {
  return error instanceof EvolitHttpSignal;
}

export function getRequestContextResponse(context) {
  const headers = Object.fromEntries(context.responseHeaders.entries());
  if (context.responseCookies.length > 0) {
    headers["set-cookie"] = context.responseCookies;
  }

  return {
    headers,
    didUseDynamicRequestData: context.didUseDynamicRequestData,
  };
}

export function applyRequestContextToResponse(response, context) {
  if (!(response instanceof Response)) {
    throw new Error("Expected a route handler to return a Web Response.");
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of context.responseHeaders.entries()) {
    headers.set(name, value);
  }
  for (const cookie of context.responseCookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
