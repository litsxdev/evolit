function throwServerOnlyApi(name) {
  throw new Error(`${name}() is only available while rendering a nexel server route.`);
}

export function cookies() { return throwServerOnlyApi("cookies"); }
export function headers() { return throwServerOnlyApi("headers"); }
export function notFound() { return throwServerOnlyApi("notFound"); }
export function permanentRedirect() { return throwServerOnlyApi("permanentRedirect"); }
export function redirect() { return throwServerOnlyApi("redirect"); }
export function requestUrl() { return throwServerOnlyApi("requestUrl"); }
export function responseHeaders() { return throwServerOnlyApi("responseHeaders"); }
