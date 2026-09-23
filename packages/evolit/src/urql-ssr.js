let adapterPromise = null;

function isMissingUrqlAdapter(error) {
  return error?.code === "ERR_MODULE_NOT_FOUND"
    && String(error.message).includes("@litsx/urql");
}

async function loadSsrUrqlAdapter() {
  try {
    return await import("@litsx/urql");
  } catch (error) {
    if (isMissingUrqlAdapter(error)) {
      return null;
    }
    throw error;
  }
}

export async function getSsrUrqlAdapter() {
  adapterPromise ??= loadSsrUrqlAdapter();
  return adapterPromise;
}

/**
 * Opens the optional @litsx/urql request scope around one complete SSR render.
 * Evolit owns only lifecycle here; client creation and URQL configuration stay
 * entirely in the application and @litsx/urql.
 */
export async function runWithOptionalSsrUrqlScope(
  contextOrCallback,
  callbackOrOptions = {},
  maybeOptions = {},
) {
  const hasRequestContext = typeof contextOrCallback !== "function";
  const requestContext = hasRequestContext ? contextOrCallback : null;
  const callback = hasRequestContext ? callbackOrOptions : contextOrCallback;
  const options = hasRequestContext ? maybeOptions : callbackOrOptions;
  if (typeof callback !== "function") {
    throw new TypeError("runWithOptionalSsrUrqlScope() expects a render callback.");
  }
  const adapter = Object.hasOwn(options, "adapter")
    ? options.adapter
    : await getSsrUrqlAdapter();
  if (!adapter) {
    return callback(null);
  }

  return hasRequestContext
    ? adapter.runWithUrqlScope(requestContext, () => callback(adapter))
    : adapter.runWithUrqlScope(() => callback(adapter));
}

/** Creates the HTTP context passed to a request-scoped URQL resource factory. */
export function createSsrUrqlRequestContext(request) {
  let didUseRequestData = false;
  const trackedRequest = new Proxy(request, {
    get(target, property) {
      if (property !== "constructor" && property !== Symbol.toStringTag) {
        didUseRequestData = true;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const responseHeaders = new Headers();
  return {
    request: trackedRequest,
    responseHeaders,
    didUseDynamicRequestData() {
      return didUseRequestData || !responseHeaders.entries().next().done;
    },
  };
}

function responseHeadersToObject(headers) {
  const values = Object.fromEntries(headers.entries());
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) values["set-cookie"] = cookies;
  }
  return values;
}

/** Applies request-resource response state before Evolit caches the render. */
export function applySsrUrqlRequestContext(routeResult, response, context) {
  if (!context) return response;
  const urqlHeaders = responseHeadersToObject(context.responseHeaders);
  if (context.didUseDynamicRequestData()) {
    routeResult.cachePolicy = { mode: "dynamic" };
  }
  if (Object.keys(urqlHeaders).length === 0) return response;
  routeResult.responseHeaders = {
    ...(routeResult.responseHeaders ?? {}),
    ...urqlHeaders,
  };
  return {
    ...response,
    headers: {
      ...(response.headers ?? {}),
      ...urqlHeaders,
    },
  };
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026");
}

/** Appends optional, application-defined URQL SSR data to an HTML response. */
export function appendSsrUrqlData(response, data) {
  if (data === undefined || typeof response?.body !== "string") {
    return response;
  }

  const script = `<script type="application/json" id="__LITSX_URQL_DATA__">${escapeJsonForHtml(data)}</script>`;
  return {
    ...response,
    body: response.body.includes("</body>")
      ? response.body.replace("</body>", `${script}\n</body>`)
      : `${response.body}${script}`,
  };
}
