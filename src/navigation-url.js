/**
 * Creates an internal navigation target without forcing callers to serialize
 * query parameters themselves. This module is deliberately browser-free so
 * it can also be shared by route code that is evaluated during SSR.
 *
 * @param {string} pathname An internal pathname, optionally with a hash.
 * @param {URLSearchParams} [searchParams] Query parameters for the target.
 * @returns {string} A relative URL suitable for navigation.
 */
export function createHref(pathname, searchParams) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new TypeError("createHref() expects an internal pathname starting with '/'.");
  }
  if (searchParams != null && !(searchParams instanceof URLSearchParams)) {
    throw new TypeError("createHref() expects URLSearchParams when query parameters are provided.");
  }

  const hashIndex = pathname.indexOf("#");
  const pathWithPossibleSearch = hashIndex < 0 ? pathname : pathname.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : pathname.slice(hashIndex);
  const queryIndex = pathWithPossibleSearch.indexOf("?");
  const path = queryIndex < 0 ? pathWithPossibleSearch : pathWithPossibleSearch.slice(0, queryIndex);
  const query = searchParams == null
    ? pathWithPossibleSearch.slice(queryIndex + 1)
    : searchParams.toString();

  return `${path}${query ? `?${query}` : ""}${hash}`;
}
