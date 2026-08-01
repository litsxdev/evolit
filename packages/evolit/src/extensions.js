/**
 * Server-side extension plumbing. This module deliberately has no browser
 * entrypoint: configured request hooks stay on the server and client hooks
 * are loaded from the separate module declared by each extension.
 */

/**
 * @typedef {object} EvolitRequestExtensionContext
 * @property {string} name
 * @property {URL} url
 * @property {string} pathname
 * @property {URLSearchParams} searchParams
 * @property {Request} request
 * @property {() => Headers} headers
 * @property {() => { get(name: string): { name: string, value: string }|undefined, has(name: string): boolean, getAll(): Array<{ name: string, value: string }> }} cookies
 * @property {() => void} markDynamic
 * @property {(key: string) => unknown} get
 * @property {(key: string, value: unknown) => void} set
 */

/**
 * @typedef {object} EvolitPlugin
 * @property {string} name
 * @property {(context: EvolitRequestExtensionContext) => void|Response|{ response?: Response, rewrite?: string, redirect?: string, status?: number }|Promise<void|Response|{ response?: Response, rewrite?: string, redirect?: string, status?: number }>} [onRequest]
 * @property {string|{ module: string, options?: unknown }} [client]
 */

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneSerializable(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  return JSON.parse(serialized);
}

function normalizeClientExtension(client, extensionName) {
  if (client == null) return null;
  const descriptor = typeof client === "string" ? { module: client } : client;
  if (!isPlainObject(descriptor) || typeof descriptor.module !== "string" || descriptor.module.length === 0) {
    throw new TypeError(`Extension ${JSON.stringify(extensionName)} client must be a module specifier or { module, options }.`);
  }
  if (descriptor.module.startsWith(".") || descriptor.module.startsWith("/")) {
    throw new TypeError(
      `Extension ${JSON.stringify(extensionName)} client module must be a package specifier. `
        + "Publish browser hooks from the integration package instead of importing application server code.",
    );
  }
  return Object.freeze({
    name: extensionName,
    module: descriptor.module,
    options: descriptor.options == null
      ? null
      : cloneSerializable(descriptor.options, `Extension ${JSON.stringify(extensionName)} client options`),
  });
}

/**
 * Normalizes the optional `plugins` array from evolit.config.js.
 * Plugins execute in declaration order. A request rewrite is passed to the
 * following plugin; a response or redirect stops the chain.
 */
export function resolveEvolitExtensions(config = {}) {
  const configured = config.plugins ?? [];
  if (!Array.isArray(configured)) {
    throw new TypeError("Expected plugins in evolit.config.js to be an array.");
  }

  const names = new Set();
  return Object.freeze(configured.map((plugin, index) => {
    if (!isPlainObject(plugin)) {
      throw new TypeError(`Expected plugins[${index}] to be an object.`);
    }
    const name = plugin.name ?? `plugin-${index + 1}`;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`Expected plugins[${index}].name to be a non-empty string.`);
    }
    if (names.has(name)) {
      throw new TypeError(`Duplicate Evolit extension name ${JSON.stringify(name)}.`);
    }
    names.add(name);
    if (plugin.onRequest != null && typeof plugin.onRequest !== "function") {
      throw new TypeError(`Extension ${JSON.stringify(name)} onRequest must be a function.`);
    }
    return Object.freeze({
      name,
      onRequest: plugin.onRequest ?? null,
      client: normalizeClientExtension(plugin.client, name),
    });
  }));
}

/**
 * Identity helper for integration packages and application configuration.
 * @param {EvolitPlugin} plugin
 * @returns {EvolitPlugin}
 */
export function defineEvolitPlugin(plugin) {
  return plugin;
}

export function getExtensionClientDescriptors(extensions = []) {
  return extensions.map((extension) => extension.client).filter(Boolean);
}

function readCookies(request) {
  const values = new Map();
  for (const entry of String(request.headers.get("cookie") ?? "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (!name) continue;
    values.set(name, decodeURIComponent(entry.slice(separator + 1).trim()));
  }
  return Object.freeze({
    get(name) {
      const value = values.get(name);
      return value == null ? undefined : { name, value };
    },
    has(name) { return values.has(name); },
    getAll() { return [...values].map(([name, value]) => ({ name, value })); },
  });
}

function normalizeRequestHookResult(result, url, extensionName) {
  if (result == null) return null;
  if (result instanceof Response) return { response: result };
  if (!isPlainObject(result)) {
    throw new TypeError(`Extension ${JSON.stringify(extensionName)} onRequest must return nothing, a Response, or { rewrite | redirect }.`);
  }
  if (result.response instanceof Response) return { response: result.response };
  if (result.redirect != null) {
    return {
      redirect: new URL(String(result.redirect), url).href,
      status: result.status == null ? 307 : Number(result.status),
    };
  }
  if (result.rewrite != null) {
    return { rewrite: new URL(String(result.rewrite), url).href };
  }
  return null;
}

/**
 * Runs server request hooks in configuration order and returns the effective
 * request URL plus request-scoped serializable values for server components.
 */
export async function runRequestExtensions(extensions, request) {
  let url = new URL(request.url);
  const values = Object.create(null);
  let didUseDynamicRequestData = false;
  const set = (key, value) => {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("Extension request context keys must be non-empty strings.");
    }
    values[key] = cloneSerializable(value, `Extension request context value ${JSON.stringify(key)}`);
  };

  for (const extension of extensions) {
    if (!extension.onRequest) continue;
    const context = Object.freeze({
      name: extension.name,
      get url() { return new URL(url); },
      get pathname() { return url.pathname; },
      get searchParams() { return new URLSearchParams(url.searchParams); },
      get request() {
        didUseDynamicRequestData = true;
        return request;
      },
      headers() {
        didUseDynamicRequestData = true;
        return request.headers;
      },
      cookies() {
        didUseDynamicRequestData = true;
        return readCookies(request);
      },
      markDynamic() { didUseDynamicRequestData = true; },
      get(key) { return values[key]; },
      set,
    });
    const normalized = normalizeRequestHookResult(
      await extension.onRequest(context),
      url,
      extension.name,
    );
    if (normalized?.response || normalized?.redirect) {
      return {
        ...normalized,
        request,
        url,
        values: Object.freeze({ ...values }),
        didUseDynamicRequestData,
      };
    }
    if (normalized?.rewrite) {
      url = new URL(normalized.rewrite);
    }
  }

  const rewrittenRequest = url.href === request.url
    ? request
    : new Request(url, request);
  return {
    request: rewrittenRequest,
    url,
    values: Object.freeze({ ...values }),
    didUseDynamicRequestData,
  };
}
