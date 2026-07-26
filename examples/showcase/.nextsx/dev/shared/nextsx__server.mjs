function throwServerOnlyApi(name) {
  throw new Error(`${name}() is only available while rendering a nextsx server route.`);
}

function cookies() { return throwServerOnlyApi("cookies"); }
function headers() { return throwServerOnlyApi("headers"); }
function notFound() { return throwServerOnlyApi("notFound"); }
function permanentRedirect() { return throwServerOnlyApi("permanentRedirect"); }
function redirect() { return throwServerOnlyApi("redirect"); }
function requestUrl() { return throwServerOnlyApi("requestUrl"); }
function responseHeaders() { return throwServerOnlyApi("responseHeaders"); }

export { cookies, headers, notFound, permanentRedirect, redirect, requestUrl, responseHeaders };
//# sourceMappingURL=nextsx__server.mjs.map
