/**
 * Builds an application into `.evolit/build`, including server output, browser assets, and
 * platform-neutral deployment manifests.
 *
 * @param {string} projectRoot Absolute path to the application root.
 * @returns {Promise<object>} The build manifest.
 */
export { buildProject } from "./build.js";

/**
 * Creates the request runtime used by standalone Node servers and deployment adapters.
 * It resolves public assets, cached responses, and render misses through one `handle()` method.
 *
 * @param {object} options Runtime configuration, including `projectRoot` and `mode`.
 * @returns {Promise<object>} A runtime with `handle(request)` and development invalidation hooks.
 */
export { createDeploymentRuntime } from "./deployment-runtime.js";

/**
 * Creates a development HTTP server with file watching and request-time compilation.
 *
 * @param {string} projectRoot Absolute path to the application root.
 * @param {object} [options] Server options, including `port`.
 * @returns {Promise<object>} A server controller with `listen()` and `close()`.
 */
export { createDevServer } from "./server.js";

/**
 * Creates a production HTTP server from existing `.evolit/build` output.
 *
 * @param {string} projectRoot Absolute path to the application root.
 * @param {object} [options] Server options, including `port`.
 * @returns {Promise<object>} A server controller with `listen()` and `close()`.
 */
export { createStartServer } from "./server.js";

/**
 * Discovers page routes, layouts, and route boundaries below an application's `app` directory.
 *
 * @param {string} projectRoot Absolute path to the application root.
 * @returns {Promise<Array<object>>} Discovered route definitions.
 */
export { discoverAppRoutes } from "./app-discovery.js";

/**
 * Discovers HTTP route handler modules below an application's `app` directory.
 *
 * @param {string} projectRoot Absolute path to the application root.
 * @returns {Promise<Array<object>>} Discovered handler definitions.
 */
export { discoverAppRouteHandlers } from "./app-discovery.js";

/**
 * Creates a starter Evolit application in an empty directory.
 *
 * @param {string} targetDirectory Directory to scaffold.
 * @param {object} [options] Scaffold options, including `name`.
 * @returns {Promise<void>}
 */
export { scaffoldSite } from "./scaffold.js";

/**
 * Creates the default LitSX SSR adapter used to turn route results into HTTP responses.
 *
 * @param {object} [options] Document metadata and rendering options.
 * @returns {object} An adapter with `renderRouteTree(routeResult)`.
 */
export { createSsrAdapter } from "./ssr-adapter.js";

/**
 * Renders a resolved route result through an SSR adapter.
 *
 * @param {object} routeResult A result returned by the route resolver.
 * @param {object} [adapter] SSR adapter. Defaults to `createSsrAdapter()`.
 * @returns {Promise<{ status: number, headers: object, body: string|ReadableStream }>} HTTP response data.
 */
export { renderRouteTreeWithAdapter } from "./ssr-adapter.js";

/**
 * Reads request cookies and exposes mutations for the outgoing response.
 * Only available while rendering a route or executing a route handler.
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
 * Signals a 404 response and renders the nearest `not-found.litsx` boundary when available.
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

/**
 * In-memory response cache store, intended for development and tests.
 */
export { MemoryResponseCacheStore } from "./response-cache.js";

/**
 * Filesystem-backed response cache store used by the standalone production runtime.
 *
 * @param {string} rootDirectory Directory where cache records are stored.
 */
export { FileSystemResponseCacheStore } from "./response-cache.js";

/**
 * Response cache store backed by caller-provided object-storage operations.
 *
 * @param {object} options Object storage callbacks and an optional key prefix.
 */
export { ObjectStorageResponseCacheStore } from "./response-cache.js";

/**
 * Creates the default cache key from a request pathname and search string.
 *
 * @param {Request} request Incoming request.
 * @returns {string} Cache key.
 */
export { createDefaultRouteCacheKey } from "./response-cache.js";

/**
 * Resolves the response cache store and cache-key factory from `evolit.config.js`.
 *
 * @param {string} projectRoot Absolute path to the application root.
 * @param {"development"|"production"} mode Runtime mode.
 * @param {object} [evolitConfig] Loaded framework configuration.
 * @returns {Promise<{ store: object, createKey: Function }>} Cache runtime hooks.
 */
export { resolveResponseCacheRuntime } from "./response-cache.js";
