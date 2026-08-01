const NAVIGATION_EXTENSIONS = Symbol.for("evolit.navigationExtensions");

/**
 * @typedef {object} EvolitNavigationExtension
 * @property {(context: { url: string, type?: string, mode?: string, from?: string, options: unknown }) => void|string|URL|{ url?: string, cancel?: boolean }} [transformUrl]
 * @property {(context: { url: string, type?: string, mode?: string, from?: string, options: unknown }) => void|false|string|URL|{ url?: string, cancel?: boolean }|Promise<void|false|string|URL|{ url?: string, cancel?: boolean }>} [beforeNavigate]
 * @property {(context: { url?: string, from?: string, type?: string, mode?: string, delta?: object, options: unknown }) => void|Promise<void>} [afterNavigate]
 */

/**
 * Identity helper for browser-only extension modules.
 * @param {EvolitNavigationExtension} extension
 * @returns {EvolitNavigationExtension}
 */
export function defineNavigationExtension(extension) {
  return extension;
}

function state() {
  return globalThis[NAVIGATION_EXTENSIONS] ??= [];
}

function normalizeClientExtension(value, descriptor) {
  const extension = value?.default ?? value?.navigation ?? value;
  if (!extension || typeof extension !== "object") {
    throw new TypeError(`Client extension ${JSON.stringify(descriptor.name)} must export an object.`);
  }
  for (const hook of ["transformUrl", "beforeNavigate", "afterNavigate"]) {
    if (extension[hook] != null && typeof extension[hook] !== "function") {
      throw new TypeError(`Client extension ${JSON.stringify(descriptor.name)} ${hook} must be a function.`);
    }
  }
  return Object.freeze({ ...extension, name: descriptor.name, options: descriptor.options ?? null });
}

/** Loads browser-only plugin modules in declaration order. */
export async function registerNavigationExtensions(descriptors = []) {
  const next = [];
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.module !== "string") continue;
    const module = await import(descriptor.module);
    next.push(normalizeClientExtension(module, descriptor));
  }
  globalThis[NAVIGATION_EXTENSIONS] = next;
  return next;
}

export function getNavigationExtensions() {
  return state();
}

function normalizeUrlResult(result, currentUrl) {
  if (result == null) return { url: currentUrl, cancelled: false };
  if (result === false) return { url: currentUrl, cancelled: true };
  if (typeof result === "string" || result instanceof URL) {
    return { url: String(result), cancelled: false };
  }
  if (typeof result === "object") {
    return {
      url: result.url == null ? currentUrl : String(result.url),
      cancelled: result.cancel === true,
    };
  }
  throw new TypeError("Navigation extension hooks must return nothing, false, a URL string, or { url, cancel }.");
}

/** Applies synchronous URL transformers in declaration order. */
export function transformNavigationUrl(url, context = {}) {
  let nextUrl = String(url);
  for (const extension of state()) {
    if (!extension.transformUrl) continue;
    const result = extension.transformUrl({ ...context, url: nextUrl, options: extension.options });
    if (result && typeof result.then === "function") {
      throw new TypeError(`Client extension ${JSON.stringify(extension.name)} transformUrl must be synchronous.`);
    }
    nextUrl = normalizeUrlResult(result, nextUrl).url;
  }
  return nextUrl;
}

export async function runBeforeNavigation(url, context = {}) {
  let nextUrl = String(url);
  for (const extension of state()) {
    if (!extension.beforeNavigate) continue;
    const result = normalizeUrlResult(
      await extension.beforeNavigate({ ...context, url: nextUrl, options: extension.options }),
      nextUrl,
    );
    if (result.cancelled) return result;
    nextUrl = result.url;
  }
  return { url: nextUrl, cancelled: false };
}

export async function runAfterNavigation(context = {}) {
  for (const extension of state()) {
    if (extension.afterNavigate) {
      await extension.afterNavigate({ ...context, options: extension.options });
    }
  }
}
