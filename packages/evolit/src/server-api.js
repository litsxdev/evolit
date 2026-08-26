/**
 * Reads request cookies and exposes mutations for the outgoing response.
 *
 * @returns {object} A cookie store with `get`, `getAll`, `has`, `set`, and `delete`.
 */
export { cookies } from "./request-context.js";

/**
 * Returns the incoming request headers. Reading headers makes the current route dynamic.
 *
 * @returns {Headers} The incoming request headers.
 */
export { headers } from "./request-context.js";

/**
 * Signals a 404 response and renders the nearest `not-found.jsx` boundary when available.
 *
 * @returns {never}
 */
export { notFound } from "./request-context.js";

/**
 * Signals a permanent redirect with HTTP status 308.
 *
 * @param {string} location Redirect destination.
 * @returns {never}
 */
export { permanentRedirect } from "./request-context.js";

/**
 * Signals a redirect response. The default status is 307.
 *
 * @param {string} location Redirect destination.
 * @param {number} [status=307] Redirect HTTP status.
 * @returns {never}
 */
export { redirect } from "./request-context.js";

/**
 * Returns the incoming request URL. Reading it makes the current route dynamic.
 *
 * @returns {URL} The incoming request URL.
 */
export { requestUrl } from "./request-context.js";

/**
 * Returns mutable response headers for the current route response.
 *
 * @returns {Headers} Headers merged into the outgoing response.
 */
export { responseHeaders } from "./request-context.js";

/** Returns the active request's extension-provided serializable values. */
export { getRequestContext } from "./request-context.js";
