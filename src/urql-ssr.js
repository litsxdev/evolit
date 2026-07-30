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
export async function runWithOptionalSsrUrqlScope(callback, options = {}) {
  const adapter = Object.hasOwn(options, "adapter")
    ? options.adapter
    : await getSsrUrqlAdapter();
  if (!adapter) {
    return callback(null);
  }

  return adapter.runWithUrqlScope(() => callback(adapter));
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
