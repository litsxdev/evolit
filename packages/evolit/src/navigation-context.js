export const EVOLIT_NAVIGATION_CONTEXT_HEADER = "x-evolit-navigation-context";
export const MAX_NAVIGATION_CONTEXT_BYTES = 8 * 1024;

function assertJsonSafe(value, path, seen, depth) {
  if (depth > 32) {
    throw new TypeError(`Navigation context at ${path} is not JSON-safe.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`Navigation context at ${path} is not JSON-safe.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Navigation context at ${path} is not JSON-safe.`);
  }
  if (seen.has(value)) {
    throw new TypeError(`Navigation context at ${path} is not JSON-safe.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Navigation context at ${path} is not JSON-safe.`);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`, seen, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function serializeNavigationContext(context) {
  if (context === null || context === undefined) return null;
  if (typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("Navigation context must be a JSON-safe object.");
  }

  assertJsonSafe(context, "context", new Set(), 0);
  const serialized = JSON.stringify(context);
  const bytes = new TextEncoder().encode(serialized);

  if (bytes.byteLength > MAX_NAVIGATION_CONTEXT_BYTES) {
    throw new RangeError("Navigation context cannot exceed 8 KiB when serialized.");
  }

  return { serialized, bytes };
}

export function normalizeNavigationContext(context) {
  const result = serializeNavigationContext(context);
  return result ? JSON.parse(result.serialized) : null;
}

export function encodeNavigationContext(context) {
  const result = serializeNavigationContext(context);
  if (!result) return null;
  const base64 = btoa(String.fromCharCode(...result.bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeNavigationContext(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  if (encoded.length > Math.ceil(MAX_NAVIGATION_CONTEXT_BYTES * 4 / 3) + 4) return null;

  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const context = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return normalizeNavigationContext(context);
  } catch {
    return null;
  }
}

export function readNavigationContext(request) {
  return decodeNavigationContext(
    request?.headers?.get?.(EVOLIT_NAVIGATION_CONTEXT_HEADER) ?? null,
  );
}
