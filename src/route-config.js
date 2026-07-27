export const DEFAULT_REVALIDATE_SECONDS = 60;

function normalizeRevalidatePolicy(cacheConfig) {
  if (!cacheConfig || typeof cacheConfig !== "object" || Array.isArray(cacheConfig)) {
    throw new Error("Expected routeConfig.cache to be an object when using revalidate mode.");
  }

  const ttlSeconds = cacheConfig.revalidate;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Expected routeConfig.cache.revalidate to be a positive integer.");
  }

  return {
    mode: "revalidate",
    ttlSeconds,
  };
}

export function normalizeRouteCachePolicy(routeConfig = {}) {
  const cacheConfig = routeConfig?.cache ?? { revalidate: DEFAULT_REVALIDATE_SECONDS };

  if (cacheConfig === "dynamic") {
    return { mode: "dynamic" };
  }

  if (cacheConfig === "static") {
    return { mode: "static" };
  }

  return normalizeRevalidatePolicy(cacheConfig);
}

export function mergeRouteConfig(modules) {
  return modules.reduce((config, moduleRecord) => {
    if (!moduleRecord || moduleRecord.routeConfig == null) {
      return config;
    }

    if (typeof moduleRecord.routeConfig !== "object" || Array.isArray(moduleRecord.routeConfig)) {
      throw new Error("Expected routeConfig to export an object.");
    }

    return {
      ...config,
      ...moduleRecord.routeConfig,
    };
  }, {});
}

export function serializeRouteCachePolicy(cachePolicy) {
  if (!cachePolicy || cachePolicy.mode === "dynamic") {
    return "dynamic";
  }

  if (cachePolicy.mode === "static") {
    return "static";
  }

  return {
    revalidate: cachePolicy.ttlSeconds,
  };
}
