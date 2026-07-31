import { adoptStyles } from "lit";

const HOT_COMPONENTS = Symbol.for("evolit.hotComponents");

function state() {
  return globalThis[HOT_COMPONENTS] ??= new Map();
}

function refreshInstances(tagName, proxy) {
  const roots = [globalThis.document].filter(Boolean);
  while (roots.length > 0) {
    const root = roots.shift();
    for (const element of root.querySelectorAll?.(tagName) ?? []) {
      if (!(element instanceof proxy)) continue;
      if (
        element.shadowRoot
        && "adoptedStyleSheets" in element.shadowRoot
        && Array.isArray(proxy.elementStyles)
      ) {
        adoptStyles(element.shadowRoot, proxy.elementStyles);
      }
      element.requestUpdate?.();
    }
    for (const element of root.querySelectorAll?.("*") ?? []) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
}

function replaceImplementation(record, implementation) {
  const previousObservedAttributes = record.proxy.observedAttributes ?? [];
  record.implementation = implementation;
  Object.setPrototypeOf(record.proxy.prototype, implementation.prototype);
  Object.setPrototypeOf(record.proxy, implementation);
  delete record.proxy.finalized;
  delete record.proxy.elementProperties;
  delete record.proxy.elementStyles;
  record.proxy.finalize?.();
  const nextObservedAttributes = record.proxy.observedAttributes ?? [];
  if (
    previousObservedAttributes.length !== nextObservedAttributes.length
    || previousObservedAttributes.some((attribute, index) => attribute !== nextObservedAttributes[index])
  ) {
    throw new Error(
      `Cannot hot-update <${record.tagName}> because its observed attributes changed.`,
    );
  }
  refreshInstances(record.tagName, record.proxy);
}

export function hotComponent(moduleId, implementation) {
  const tagName = implementation?.[Symbol.for("litsx.hydratableTag")];
  if (typeof tagName !== "string" || tagName.length === 0) return implementation;
  const key = `${moduleId}::${tagName}`;
  const existing = state().get(key);
  if (existing) {
    replaceImplementation(existing, implementation);
    return existing.proxy;
  }

  class EvolitHotComponentProxy extends implementation {}
  const record = { tagName, proxy: EvolitHotComponentProxy, implementation };
  state().set(key, record);
  return record.proxy;
}
