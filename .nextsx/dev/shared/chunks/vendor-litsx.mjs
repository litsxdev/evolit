import { S, i, y } from './vendor-lit.mjs';
import { A, D, l, b } from './vendor-lit-html.mjs';
import './vendor-hydration-support.mjs';

/**
 * @license
 * Copyright (c) 2020 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 *
 * Adapted for LitSX shimmed scoped-registry runtime.
 */

const RUNTIME_KEY = Symbol.for("litsx.lightDomRegistry.runtime");
const HOST_REGISTRY = Symbol.for("litsx.lightDomRegistry.hostRegistry");
const HOST_ELEMENTS = Symbol.for("litsx.lightDomRegistry.hostElements");
const STAND_IN_MARK = Symbol.for("litsx.lightDomRegistry.standIn");

function isBrowserLikeEnvironment() {
  return typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof customElements !== "undefined" &&
    typeof HTMLElement !== "undefined";
}

function isRegistryLike(value) {
  return value &&
    typeof value.define === "function" &&
    typeof value.get === "function" &&
    typeof value._getDefinition === "function";
}

function getRuntime() {
  if (!isBrowserLikeEnvironment()) {
    return null;
  }

  if (window[RUNTIME_KEY]) {
    return window[RUNTIME_KEY];
  }

  const polyfillWindow = window;
  if (!polyfillWindow.CustomElementRegistryPolyfill?.formAssociated) {
    polyfillWindow.CustomElementRegistryPolyfill = {
      formAssociated: new Set(),
    };
  }

  const NativeHTMLElement = window.HTMLElement;
  const nativeRegistry = window.customElements;
  const nativeDefine = nativeRegistry.define.bind(nativeRegistry);
  const nativeGet = nativeRegistry.get.bind(nativeRegistry);

  const definitionForElement = new WeakMap();
  const pendingRegistryForElement = new WeakMap();
  const globalDefinitionForConstructor = new WeakMap();
  const scopeForElement = new WeakMap();
  const standInDefinitionByTag = new Map();
  let globalRegistry;

  let upgradingInstance;
  let elementsPendingAttributes;

  if (document.readyState === "loading") {
    elementsPendingAttributes = new Set();
    document.addEventListener("readystatechange", () => {
      elementsPendingAttributes.forEach((instance) =>
        customizeAttributes(instance, definitionForElement.get(instance))
      );
    }, { once: true });
  }

  class AsyncInfo {
    constructor() {
      this.promise = new Promise((resolve) => {
        this.resolve = resolve;
      });
    }
  }

  class ShimmedCustomElementsRegistry {
    constructor(host = null) {
      this.host = host;
      this._definitionsByTag = new Map();
      this._definitionsByClass = new Map();
      this._whenDefinedPromises = new Map();
      this._awaitingUpgrade = new Map();
    }

    define(tagName, elementClass) {
      tagName = String(tagName).toLowerCase();
      if (!tagName) {
        throw new DOMException(
          "Failed to execute 'define' on 'CustomElementRegistry': the tag name must not be empty"
        );
      }
      if (this._getDefinition(tagName) !== undefined) {
        throw new DOMException(
          `Failed to execute 'define' on 'CustomElementRegistry': the name "${tagName}" has already been used with this registry`
        );
      }
      if (this._definitionsByClass.get(elementClass) !== undefined) {
        throw new DOMException(
          "Failed to execute 'define' on 'CustomElementRegistry': this constructor has already been used with this registry"
        );
      }

      const attributeChangedCallback = elementClass.prototype.attributeChangedCallback;
      const observedAttributes = new Set(elementClass.observedAttributes || []);
      patchAttributes(elementClass, observedAttributes, attributeChangedCallback);

      let standInClass = nativeGet(tagName);
      if (standInClass && !standInClass[STAND_IN_MARK]) ;

      const formAssociated =
        standInClass?.formAssociated ??
        (elementClass.formAssociated ||
          polyfillWindow.CustomElementRegistryPolyfill.formAssociated.has(tagName));

      if (formAssociated) {
        polyfillWindow.CustomElementRegistryPolyfill.formAssociated.add(tagName);
      }

      if (formAssociated !== elementClass.formAssociated) {
        try {
          elementClass.formAssociated = formAssociated;
        } catch {
          // ignore write failures on readonly constructors
        }
      }

      const definition = {
        tagName,
        elementClass,
        g: elementClass,
        connectedCallback: elementClass.prototype.connectedCallback,
        disconnectedCallback: elementClass.prototype.disconnectedCallback,
        adoptedCallback: elementClass.prototype.adoptedCallback,
        attributeChangedCallback,
        formAssociated,
        formAssociatedCallback: elementClass.prototype.formAssociatedCallback,
        formDisabledCallback: elementClass.prototype.formDisabledCallback,
        formResetCallback: elementClass.prototype.formResetCallback,
        formStateRestoreCallback: elementClass.prototype.formStateRestoreCallback,
        observedAttributes,
      };

      this._definitionsByTag.set(tagName, definition);
      this._definitionsByClass.set(elementClass, definition);

      if (!standInClass) {
        standInClass = createStandInElement(tagName);
        standInClass[STAND_IN_MARK] = true;
        nativeDefine(tagName, standInClass);
      }

      definition.standInClass = standInClass;
      definition.o = standInClass;
      standInDefinitionByTag.set(tagName, definition);
      globalDefinitionForConstructor.set(elementClass, definition);

      const awaiting = this._awaitingUpgrade.get(tagName);
      if (awaiting) {
        this._awaitingUpgrade.delete(tagName);
        for (const element of awaiting) {
          pendingRegistryForElement.delete(element);
          customize(element, definition, true);
        }
      }

      const info = this._whenDefinedPromises.get(tagName);
      if (info) {
        info.resolve(elementClass);
        this._whenDefinedPromises.delete(tagName);
      }

      return elementClass;
    }

    get(tagName) {
      return this._definitionsByTag.get(tagName)?.elementClass ?? null;
    }

    getName(elementClass) {
      return this._definitionsByClass.get(elementClass)?.tagName ?? null;
    }

    _getDefinition(tagName) {
      return this._definitionsByTag.get(String(tagName).toLowerCase());
    }

    whenDefined(tagName) {
      const definition = this._getDefinition(tagName);
      if (definition !== undefined) {
        return Promise.resolve(definition.elementClass);
      }
      let info = this._whenDefinedPromises.get(tagName);
      if (info === undefined) {
        info = new AsyncInfo();
        this._whenDefinedPromises.set(tagName, info);
      }
      return info.promise;
    }

    _upgradeWhenDefined(element, tagName, shouldUpgrade) {
      let awaiting = this._awaitingUpgrade.get(tagName);
      if (!awaiting) {
        awaiting = new Set();
        this._awaitingUpgrade.set(tagName, awaiting);
      }
      if (shouldUpgrade) {
        awaiting.add(element);
      } else {
        awaiting.delete(element);
      }
    }

    resolve(tagName) {
      const definition = this._getDefinition(tagName);
      if (!definition) {
        return null;
      }
      return {
        host: this.host,
        ctor: definition.elementClass,
        tagName: definition.tagName,
        standInClass: definition.standInClass ?? null,
      };
    }

    entries() {
      return Array.from(this._definitionsByTag.entries()).map(([tagName, definition]) => [
        tagName,
        definition.elementClass,
      ]);
    }
  }

  const isValidScope = (node) =>
    node === document || node instanceof ShadowRoot;

  const registryFromScope = (scope) => {
    if (!scope) {
      return null;
    }
    if (isRegistryLike(scope.registry)) {
      return scope.registry;
    }
    if (isRegistryLike(scope.customElements)) {
      return scope.customElements;
    }
    if (scope.nodeType === Node.ELEMENT_NODE && isRegistryLike(scope[HOST_REGISTRY])) {
      return scope[HOST_REGISTRY];
    }
    if (scope === document && isRegistryLike(globalRegistry)) {
      return globalRegistry;
    }
    return null;
  };

  const registryForNode = (node) => {
    let current = node;

    while (current) {
      const direct = registryFromScope(current);
      if (direct) {
        return direct;
      }

      const root = typeof current.getRootNode === "function"
        ? current.getRootNode()
        : null;
      if (root && root !== current) {
        const rootRegistry = registryFromScope(root);
        if (rootRegistry && root !== document) {
          return rootRegistry;
        }
      }

      if (current.parentNode) {
        current = current.parentNode;
        continue;
      }

      if (current instanceof ShadowRoot && current.host) {
        current = current.host;
        continue;
      }

      break;
    }

    let scope = node.getRootNode?.() ?? null;
    if (!isValidScope(scope)) {
      const context = creationContext[creationContext.length - 1];
      if (isRegistryLike(context)) {
        return context;
      }
      const contextRegistry = registryFromScope(context);
      if (contextRegistry) {
        return contextRegistry;
      }
      if (context?.getRootNode) {
        scope = context.getRootNode();
      }
      if (!isValidScope(scope)) {
        scope = scopeForElement.get(scope)?.getRootNode?.() || document;
      }
    }

    return registryFromScope(scope);
  };

  function ensureAttributesCustomized(instance) {
    if (!elementsPendingAttributes?.has(instance)) {
      return;
    }
    customizeAttributes(instance, definitionForElement.get(instance));
  }

  function customizeAttributes(instance, definition) {
    elementsPendingAttributes?.delete(instance);
    if (!definition?.attributeChangedCallback) {
      return;
    }
    definition.observedAttributes.forEach((attr) => {
      if (!instance.hasAttribute(attr)) {
        return;
      }
      definition.attributeChangedCallback.call(
        instance,
        attr,
        null,
        instance.getAttribute(attr)
      );
    });
  }

  function patchAttributes(elementClass, observedAttributes, attributeChangedCallback) {
    if (observedAttributes.size === 0 || attributeChangedCallback === undefined) {
      return;
    }

    const setAttribute = elementClass.prototype.setAttribute;
    if (setAttribute && !setAttribute.__litsxPatched) {
      const patched = function (name, value) {
        ensureAttributesCustomized(this);
        const normalizedName = String(name).toLowerCase();
        if (observedAttributes.has(normalizedName)) {
          const oldValue = this.getAttribute(normalizedName);
          setAttribute.call(this, normalizedName, value);
          attributeChangedCallback.call(this, normalizedName, oldValue, value);
        } else {
          setAttribute.call(this, normalizedName, value);
        }
      };
      patched.__litsxPatched = true;
      elementClass.prototype.setAttribute = patched;
    }

    const removeAttribute = elementClass.prototype.removeAttribute;
    if (removeAttribute && !removeAttribute.__litsxPatched) {
      const patched = function (name) {
        ensureAttributesCustomized(this);
        const normalizedName = String(name).toLowerCase();
        if (observedAttributes.has(normalizedName)) {
          const oldValue = this.getAttribute(normalizedName);
          removeAttribute.call(this, normalizedName);
          attributeChangedCallback.call(this, normalizedName, oldValue, null);
        } else {
          removeAttribute.call(this, normalizedName);
        }
      };
      patched.__litsxPatched = true;
      elementClass.prototype.removeAttribute = patched;
    }

    const toggleAttribute = elementClass.prototype.toggleAttribute;
    if (toggleAttribute && !toggleAttribute.__litsxPatched) {
      const patched = function (name, force) {
        ensureAttributesCustomized(this);
        const normalizedName = String(name).toLowerCase();
        if (observedAttributes.has(normalizedName)) {
          const oldValue = this.getAttribute(normalizedName);
          toggleAttribute.call(this, normalizedName, force);
          const newValue = this.getAttribute(normalizedName);
          if (oldValue !== newValue) {
            attributeChangedCallback.call(this, normalizedName, oldValue, newValue);
          }
          return newValue !== null;
        }
        return toggleAttribute.call(this, normalizedName, force);
      };
      patched.__litsxPatched = true;
      elementClass.prototype.toggleAttribute = patched;
    }
  }

  function patchHTMLElement(elementClass) {
    const parentClass = Object.getPrototypeOf(elementClass);

    if (parentClass !== window.HTMLElement) {
      if (parentClass === NativeHTMLElement) {
        Object.setPrototypeOf(elementClass, window.HTMLElement);
        return;
      }
      patchHTMLElement(parentClass);
    }
  }

  function customize(instance, definition, isUpgrade = false) {
    Object.setPrototypeOf(instance, definition.elementClass.prototype);
    definitionForElement.set(instance, definition);
    upgradingInstance = instance;
    try {
      new definition.elementClass();
    } catch {
      patchHTMLElement(definition.elementClass);
      new definition.elementClass();
    }

    if (definition.attributeChangedCallback) {
      if (elementsPendingAttributes !== undefined && !instance.hasAttributes()) {
        elementsPendingAttributes.add(instance);
      } else {
        customizeAttributes(instance, definition);
      }
    }

    if (isUpgrade && definition.connectedCallback && instance.isConnected) {
      definition.connectedCallback.call(instance);
    }
  }

  function createStandInElement(tagName) {
    return class ScopedCustomElementBase {
      static get formAssociated() {
        return polyfillWindow.CustomElementRegistryPolyfill.formAssociated.has(tagName);
      }

      constructor() {
        const instance = Reflect.construct(NativeHTMLElement, [], this.constructor);
        Object.setPrototypeOf(instance, window.HTMLElement.prototype);

        const registry = registryForNode(instance);
        const definition = registry?._getDefinition(tagName);
        if (definition) {
          customize(instance, definition);
        } else if (registry) {
          pendingRegistryForElement.set(instance, registry);
        }
        return instance;
      }

      connectedCallback(...args) {
        ensureAttributesCustomized(this);
        const definition = definitionForElement.get(this);
        if (definition) {
          definition.connectedCallback?.apply(this, args);
          return;
        }

        const registry = pendingRegistryForElement.get(this) || registryForNode(this);
        if (!registry) {
          return;
        }

        const resolvedDefinition = registry._getDefinition(tagName);
        if (resolvedDefinition) {
          pendingRegistryForElement.delete(this);
          customize(this, resolvedDefinition, true);
          return;
        }

        pendingRegistryForElement.set(this, registry);
        registry._upgradeWhenDefined(this, tagName, true);
      }

      disconnectedCallback(...args) {
        const definition = definitionForElement.get(this);
        if (definition) {
          definition.disconnectedCallback?.apply(this, args);
          return;
        }

        const registry = pendingRegistryForElement.get(this);
        registry?._upgradeWhenDefined(this, tagName, false);
      }

      adoptedCallback(...args) {
        const definition = definitionForElement.get(this);
        definition?.adoptedCallback?.apply(this, args);
      }

      formAssociatedCallback(...args) {
        const definition = definitionForElement.get(this);
        if (definition?.formAssociated) {
          definition.formAssociatedCallback?.apply(this, args);
        }
      }

      formDisabledCallback(...args) {
        const definition = definitionForElement.get(this);
        if (definition?.formAssociated) {
          definition.formDisabledCallback?.apply(this, args);
        }
      }

      formResetCallback(...args) {
        const definition = definitionForElement.get(this);
        if (definition?.formAssociated) {
          definition.formResetCallback?.apply(this, args);
        }
      }

      formStateRestoreCallback(...args) {
        const definition = definitionForElement.get(this);
        if (definition?.formAssociated) {
          definition.formStateRestoreCallback?.apply(this, args);
        }
      }
    };
  }

  function upgradeCreatedElement(element, registry) {
    if (
      !element ||
      element.nodeType !== Node.ELEMENT_NODE ||
      !registry ||
      typeof registry._getDefinition !== "function"
    ) {
      return false;
    }

    const tagName = element.localName || element.tagName?.toLowerCase?.();
    const definition = tagName ? registry._getDefinition(tagName) : null;
    const currentDefinition = definitionForElement.get(element) ?? null;
    const effectiveRegistry = registryForNode(element);
    if (effectiveRegistry && effectiveRegistry !== registry) {
      return false;
    }
    if (
      currentDefinition &&
      (!definition || currentDefinition.elementClass === definition.elementClass)
    ) {
      return false;
    }

    if (definition) {
      customize(element, definition, element.isConnected);
      return true;
    }

    return false;
  }

  function upgradeCreatedTree(node, registry) {
    if (!node || !registry) {
      return;
    }

    if (
      node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE &&
      node.nodeType !== Node.ELEMENT_NODE
    ) {
      return;
    }

    const pending = [node];
    while (pending.length > 0) {
      const current = pending.shift();
      if (current.nodeType === Node.ELEMENT_NODE) {
        upgradeCreatedElement(current, registry);
      }

      for (const child of current.children ?? []) {
        pending.push(child);
      }
    }
  }

  function upgradeConnectedTree(node, registry) {
    if (!node || !registry) {
      return;
    }

    if (
      node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE &&
      node.nodeType !== Node.ELEMENT_NODE
    ) {
      return;
    }

    const pending = [node];
    while (pending.length > 0) {
      const current = pending.shift();
      if (current.nodeType !== Node.ELEMENT_NODE) {
        for (const child of current.children ?? []) {
          pending.push(child);
        }
        continue;
      }

      upgradeCreatedElement(current, registry);

      for (const child of current.children ?? []) {
        pending.push(child);
      }
    }
  }

  function collectInsertedNodes(node) {
    if (!node) {
      return [];
    }

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return Array.from(node.children ?? []);
    }

    return [node];
  }

  window.HTMLElement = function HTMLElement() {
    let instance = upgradingInstance;
    if (instance) {
      upgradingInstance = undefined;
      return instance;
    }

    const definition = globalDefinitionForConstructor.get(this.constructor);
    if (!definition) {
      try {
        return Reflect.construct(NativeHTMLElement, [], this.constructor);
      } catch {
        throw new TypeError(
          "Illegal constructor (custom element class must be registered with the LitSX scoped-registry shim runtime to be newable)"
        );
      }
    }

    instance = Reflect.construct(NativeHTMLElement, [], definition.standInClass);
    Object.setPrototypeOf(instance, this.constructor.prototype);
    definitionForElement.set(instance, definition);
    return instance;
  };
  window.HTMLElement.prototype = NativeHTMLElement.prototype;

  const creationContext = [document];

  function installScopedCreationMethod(ctor, method, from) {
    const native = (from ? Object.getPrototypeOf(from) : ctor.prototype)[method];
    if (typeof native !== "function") {
      return;
    }

    ctor.prototype[method] = function (...args) {
      creationContext.push(this);
      const result = native.apply(from || this, args);
      const registry = registryForNode(this);
      upgradeCreatedTree(result, registry);
      if (result !== undefined) {
        scopeForElement.set(result, this);
      } else if (method === "insertAdjacentHTML") {
        upgradeConnectedTree(this, registry);
      }
      creationContext.pop();
      return result;
    };
  }

  function installScopedCreationSetter(ctor, name) {
    const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, name);
    if (!descriptor?.set) {
      return;
    }
    Object.defineProperty(ctor.prototype, name, {
      ...descriptor,
      set(value) {
        creationContext.push(this);
        descriptor.set.call(this, value);
        const registry = registryForNode(this);
        for (const child of this.children ?? []) {
          upgradeConnectedTree(child, registry);
        }
        creationContext.pop();
      },
    });
  }

  function installScopedInsertionMethod(ctor, method) {
    const native = ctor.prototype[method];
    if (typeof native !== "function") {
      return;
    }

    ctor.prototype[method] = function (node, ...args) {
      const insertedNodes = collectInsertedNodes(node);
      const result = native.call(this, node, ...args);
      const registry = registryForNode(this);
      for (const inserted of insertedNodes) {
        upgradeConnectedTree(inserted, registry);
      }
      return result;
    };
  }

  installScopedCreationMethod(ShadowRoot, "createElement", document);
  installScopedCreationMethod(ShadowRoot, "createElementNS", document);
  installScopedCreationMethod(ShadowRoot, "importNode", document);
  installScopedInsertionMethod(ShadowRoot, "appendChild");
  installScopedInsertionMethod(ShadowRoot, "insertBefore");
  installScopedCreationMethod(Element, "insertAdjacentHTML");
  installScopedCreationSetter(Element, "innerHTML");
  installScopedCreationSetter(ShadowRoot, "innerHTML");

  const runtime = {
    NativeHTMLElement,
    ShimmedCustomElementsRegistry,
    createRegistry(host) {
      return new ShimmedCustomElementsRegistry(host);
    },
    ensureLightDomProxy(tagName) {
      const normalizedTag = String(tagName).toLowerCase();
      const existing = nativeGet(normalizedTag);
      if (existing) {
        if (existing[STAND_IN_MARK]) {
          return existing;
        }
        throw new Error(
          `Global custom element tag "${normalizedTag}" is already registered to a different constructor.`
        );
      }
      const standInClass = createStandInElement(normalizedTag);
      standInClass[STAND_IN_MARK] = true;
      nativeDefine(normalizedTag, standInClass);
      return standInClass;
    },
    getDefinitionForElement(element) {
      return definitionForElement.get(element) ?? null;
    },
    getStandInDefinition(tagName) {
      return standInDefinitionByTag.get(String(tagName).toLowerCase()) ?? null;
    },
    upgradeTree(node, registry) {
      upgradeConnectedTree(node, registry);
    },
    retargetPendingTree(node, fromRegistry, toRegistry) {
      if (!node || !fromRegistry || !toRegistry || fromRegistry === toRegistry) {
        return;
      }

      const pending = [node];
      while (pending.length > 0) {
        const current = pending.shift();
        if (current.nodeType === Node.ELEMENT_NODE) {
          if (pendingRegistryForElement.get(current) === fromRegistry) {
            const tagName = current.localName || current.tagName?.toLowerCase?.();
            fromRegistry._upgradeWhenDefined?.(current, tagName, false);
            pendingRegistryForElement.set(current, toRegistry);

            const nextDefinition = tagName ? toRegistry._getDefinition?.(tagName) : null;
            if (nextDefinition) {
              customize(current, nextDefinition, current.isConnected);
            } else if (current.isConnected && tagName) {
              toRegistry._upgradeWhenDefined?.(current, tagName, true);
            }
          }
        }

        for (const child of current.children ?? []) {
          pending.push(child);
        }
      }
    },
    withCreationContext(scope, callback) {
      creationContext.push(scope ?? document);
      try {
        return callback();
      } finally {
        creationContext.pop();
      }
    },
  };

  globalRegistry = new ShimmedCustomElementsRegistry();
  if (nativeRegistry.h && typeof nativeRegistry.h.get === "function") {
    globalRegistry.h = {
      get(tagName) {
        return globalRegistry._getDefinition(tagName) ?? nativeRegistry.h.get(tagName);
      },
      set(tagName, definition) {
        globalRegistry._definitionsByTag.set(tagName, definition);
        return this;
      },
      has(tagName) {
        return globalRegistry._definitionsByTag.has(tagName) || nativeRegistry.h.has?.(tagName);
      },
      delete(tagName) {
        return globalRegistry._definitionsByTag.delete(tagName);
      },
    };
    globalRegistry.i = new Map();
  }
  globalRegistry.get = function get(tagName) {
    const definition = this._getDefinition(tagName);
    if (definition) {
      return definition.elementClass;
    }
    const ctor = nativeGet(String(tagName).toLowerCase());
    return ctor?.[STAND_IN_MARK] ? undefined : ctor;
  };
  globalRegistry.upgrade = function upgrade(root) {
    return nativeRegistry.upgrade?.(root);
  };

  Object.defineProperty(window, "customElements", {
    value: globalRegistry,
    configurable: true,
    writable: true,
  });

  window[RUNTIME_KEY] = runtime;
  return runtime;
}

function isLightDomRegistryRuntimeActive() {
  return isBrowserLikeEnvironment() && Boolean(window[RUNTIME_KEY]);
}

function createLightDomRegistry(host, initialElements = {}) {
  const runtime = getRuntime();
  if (!runtime) {
    return null;
  }

  const registry = runtime.createRegistry(host);
  host[HOST_REGISTRY] = registry;
  host[HOST_ELEMENTS] = { ...(initialElements || {}) };
  host.registry = registry;

  Object.entries(initialElements || {}).forEach(([tagName, ctor]) => {
    registry.define(tagName, ctor);
  });

  return registry;
}

function withLightDomCreationContext(scope, callback) {
  const runtime = getRuntime();
  if (!runtime || typeof callback !== "function") {
    return typeof callback === "function" ? callback() : undefined;
  }

  return runtime.withCreationContext(scope, callback);
}

function upgradeScopedRegistryTree(node, registry) {
  const runtime = getRuntime();
  if (!runtime || !node || !isRegistryLike(registry)) {
    return;
  }

  runtime.upgradeTree(node, registry);
}

const DEDUPE_MIXIN_MARK = Symbol("litsx.dedupeMixinMark");
const HYDRATION_RENDER_BEFORE = Symbol("litsx.hydrationRenderBefore");
const LIGHT_DOM_STYLE_ELEMENT = Symbol("litsx.lightDomStyleElement");
const SHADOW_DOM_REGISTRY = Symbol("litsx.shadowDomRegistry");
const LITSX_COMPONENT = Symbol.for("litsx.component");
const LITSX_HOST_TYPE_ID = Symbol.for("litsx.hostTypeId");
const LITSX_HYDRATABLE_TAG = Symbol.for("litsx.hydratableTag");
const LITSX_SCOPED_TEMPLATE = Symbol.for("litsx.scopedTemplate");
const LITSX_MODULE_ID = Symbol.for("litsx.moduleId");
const LITSX_SSR_CONTEXT = Symbol.for("litsx.ssrContext");
const LITSX_SERVER_COMPONENT = Symbol.for("litsx.serverComponent");
const LITSX_SERVER_COMPONENT_CALL = Symbol.for("litsx.serverComponentCall");
const LITSX_LIGHT_DOM = Symbol.for("litsx.lightDom");
let shadowDomRegistryAttachKey;
let shadowDomRegistryAttachShadowRef;
let shadowDomRegistryCtorRef;
let shadowDomRegistryNativeSupport;

function isLitsxComponentClass(value) {
  return typeof value === "function" && value[LITSX_COMPONENT] === true;
}

function isCustomElementClass(value) {
  if (typeof value !== "function") {
    return false;
  }

  const HTMLElementCtor = globalThis.HTMLElement;
  if (typeof HTMLElementCtor === "function") {
    return value === HTMLElementCtor || value.prototype instanceof HTMLElementCtor;
  }

  return /^class\s/.test(Function.prototype.toString.call(value));
}

function isHydratableCustomElementClass(value) {
  return (
    isCustomElementClass(value) &&
    typeof value[LITSX_HYDRATABLE_TAG] === "string" &&
    value[LITSX_HYDRATABLE_TAG].length > 0
  );
}

function annotateHydratableCustomElement(ctor, metadata = {}) {
  if (!isCustomElementClass(ctor)) {
    throw new TypeError("Expected a custom element constructor.");
  }

  const tagName = typeof metadata.tagName === "string"
    ? metadata.tagName.trim()
    : "";
  if (tagName && !ctor[LITSX_HYDRATABLE_TAG]) {
    ctor[LITSX_HYDRATABLE_TAG] = tagName;
  }

  const moduleId = typeof metadata.moduleId === "string"
    ? metadata.moduleId.trim()
    : "";
  if (moduleId && !ctor[LITSX_MODULE_ID]) {
    ctor[LITSX_MODULE_ID] = moduleId;
  }

  return ctor;
}

function getElementAttachShadowRef$1() {
  return typeof Element !== "undefined" ? Element.prototype.attachShadow : undefined;
}
let shadowDomRegistryProbeId = 0;

function __litsxScopedTemplate(template, elements) {
  return {
    [LITSX_SCOPED_TEMPLATE]: true,
    template,
    elements: elements ?? {},
  };
}

function __isLitsxScopedTemplate(value) {
  return Boolean(value?.[LITSX_SCOPED_TEMPLATE]);
}

function __litsxServerComponentCall(component, props) {
  return {
    [LITSX_SERVER_COMPONENT_CALL]: true,
    component,
    props: props ?? {},
  };
}

function __isLitsxServerComponentCall(value) {
  return Boolean(value?.[LITSX_SERVER_COMPONENT_CALL]);
}

function isPolyfilledScopedRegistry(registry) {
  return Boolean(registry && "h" in registry && "m" in registry);
}

function supportsScopedRegistryElementCreation(shadowRoot, registry) {
  if (!shadowRoot || !registry) {
    return false;
  }

  const canCreateElement = typeof shadowRoot.createElement === "function";
  const canParseElement = typeof shadowRoot.querySelector === "function";
  if (!canCreateElement && !canParseElement) {
    return true;
  }

  const tagName = `litsx-scoped-registry-probe-${shadowDomRegistryProbeId++}`;
  const parsedTagName = `litsx-scoped-registry-parsed-probe-${shadowDomRegistryProbeId++}`;
  class ScopedRegistryProbe extends HTMLElement {}
  class ParsedScopedRegistryProbe extends HTMLElement {}

  try {
    registry.define(tagName, ScopedRegistryProbe);
    registry.define(parsedTagName, ParsedScopedRegistryProbe);
    const createdElementWorks =
      !canCreateElement ||
      shadowRoot.createElement(tagName) instanceof ScopedRegistryProbe;
    let parsedElementWorks = true;
    if (canParseElement) {
      shadowRoot.innerHTML = `<${parsedTagName}></${parsedTagName}>`;
      parsedElementWorks =
        shadowRoot.querySelector(parsedTagName) instanceof ParsedScopedRegistryProbe;
      shadowRoot.textContent = "";
    }
    return createdElementWorks && parsedElementWorks;
  } catch {
    return false;
  }
}

function getShadowDomRegistryAttachKey(registryOverride = null) {
  if (registryOverride) {
    if (isPolyfilledScopedRegistry(registryOverride)) {
      return null;
    }

    if (
      typeof CustomElementRegistry === "function" &&
      !(registryOverride instanceof CustomElementRegistry)
    ) {
      return null;
    }

    for (const key of ["registry", "customElements", "customElementRegistry"]) {
      const host = document.createElement("div");
      try {
        const shadowRoot = host.attachShadow({
          mode: "open",
          [key]: registryOverride,
        });
        if (
          shadowRoot?.[key] === registryOverride &&
          supportsScopedRegistryElementCreation(shadowRoot, registryOverride)
        ) {
          return key;
        }
      } catch {
        // Try the next known option name.
      }
    }
    return null;
  }

  if (
    shadowDomRegistryAttachKey !== undefined &&
    shadowDomRegistryAttachShadowRef === getElementAttachShadowRef$1() &&
    shadowDomRegistryCtorRef === globalThis.CustomElementRegistry &&
    shadowDomRegistryNativeSupport !== undefined
  ) {
    return shadowDomRegistryAttachKey;
  }

  if (
    typeof document === "undefined" ||
    typeof CustomElementRegistry !== "function" ||
    typeof Element === "undefined"
  ) {
    shadowDomRegistryAttachKey = null;
    shadowDomRegistryAttachShadowRef = getElementAttachShadowRef$1();
    shadowDomRegistryCtorRef = globalThis.CustomElementRegistry;
    shadowDomRegistryNativeSupport = false;
    return null;
  }

  let registry;
  try {
    registry = new CustomElementRegistry();
  } catch {
    shadowDomRegistryAttachKey = null;
    shadowDomRegistryAttachShadowRef = getElementAttachShadowRef$1();
    shadowDomRegistryCtorRef = globalThis.CustomElementRegistry;
    shadowDomRegistryNativeSupport = false;
    return null;
  }

  if (isPolyfilledScopedRegistry(registry)) {
    shadowDomRegistryAttachKey = null;
    shadowDomRegistryAttachShadowRef = getElementAttachShadowRef$1();
    shadowDomRegistryCtorRef = globalThis.CustomElementRegistry;
    shadowDomRegistryNativeSupport = false;
    return null;
  }

  for (const key of ["registry", "customElements", "customElementRegistry"]) {
    const host = document.createElement("div");
    try {
      const shadowRoot = host.attachShadow({
        mode: "open",
        [key]: registry,
      });
      if (
        shadowRoot?.[key] === registry &&
        supportsScopedRegistryElementCreation(shadowRoot, registry)
      ) {
        shadowDomRegistryAttachKey = key;
        shadowDomRegistryAttachShadowRef = getElementAttachShadowRef$1();
        shadowDomRegistryCtorRef = globalThis.CustomElementRegistry;
        shadowDomRegistryNativeSupport = true;
        return shadowDomRegistryAttachKey;
      }
    } catch {
      // Try the next known option name.
    }
  }

  shadowDomRegistryAttachKey = null;
  shadowDomRegistryAttachShadowRef = getElementAttachShadowRef$1();
  shadowDomRegistryCtorRef = globalThis.CustomElementRegistry;
  shadowDomRegistryNativeSupport = false;
  return null;
}

function defineScopedElements$1(registry, elements = {}) {
  for (const [tagName, elementClass] of Object.entries(elements)) {
    if (!tagName || typeof elementClass !== "function") {
      continue;
    }

    const existing = registry.get?.(tagName);
    if (existing === elementClass) {
      continue;
    }

    if (existing && existing !== elementClass) {
      throw new Error(
        `ShadowDomMixin cannot redefine scoped element "${tagName}" with a different constructor.`
      );
    }

    registry.define(tagName, elementClass);
  }

  return registry;
}

function createScopedRegistryForHost(host, options = {}) {
  const ctor = host.constructor;
  const elements = ctor.scopedElements ?? ctor.elements ?? {};
  let registry = host.registry ?? null;
  let attachKey = null;

  if (options.forceLightDomRegistry && !isPolyfilledScopedRegistry(registry)) {
    registry = null;
    host.registry = null;
  }

  if (!registry && options.forceLightDomRegistry) {
    registry = createLightDomRegistry(host, {});
  }

  if (!registry) {
    if (!isLightDomRegistryRuntimeActive()) {
      attachKey = getShadowDomRegistryAttachKey();
      if (attachKey) {
        registry = new CustomElementRegistry();
      }
    }
  }

  if (!registry && !options.forceLightDomRegistry) {
    attachKey = getShadowDomRegistryAttachKey();
    if (attachKey) {
      registry = new CustomElementRegistry();
    }
  }

  if (!registry) {
    registry = createLightDomRegistry(host, {});
  }

  if (attachKey === null) {
    attachKey = getShadowDomRegistryAttachKey(registry);
  }

  defineScopedElements$1(registry, elements);
  host.registry = registry;

  return { attachKey, registry };
}

function assignShadowRootRegistry$1(shadowRoot, registry) {
  for (const key of ["registry", "customElements", "customElementRegistry"]) {
    try {
      shadowRoot[key] = registry;
    } catch {
      // Some browsers expose readonly experimental registry aliases.
    }
  }
}

function cssTextFromStyle(style) {
  if (!style) return "";

  if (typeof style.cssText === "string") {
    return style.cssText;
  }

  if (typeof CSSStyleSheet !== "undefined" && style instanceof CSSStyleSheet) {
    let cssText = "";
    for (const rule of style.cssRules || []) {
      cssText += rule.cssText;
    }
    return cssText;
  }

  return String(style);
}

function ensureLightDomStyles(host) {
  if (!host) {
    return;
  }

  const ctor = host.constructor;
  if (typeof ctor.finalize === "function") {
    ctor.finalize();
  }

  const styles = Array.isArray(ctor.elementStyles) ? ctor.elementStyles : [];
  if (styles.length === 0) {
    return;
  }

  const styleTexts = styles
    .map(cssTextFromStyle)
    .filter(Boolean);

  if (styleTexts.length === 0) {
    return;
  }

  const cssText = styleTexts.join("\n");
  let styleElement = host[LIGHT_DOM_STYLE_ELEMENT];

  if (styleElement?.isConnected) {
    if (styleElement.textContent !== cssText) {
      styleElement.textContent = cssText;
    }
    return;
  }

  styleElement = host.ownerDocument.createElement("style");
  styleElement.setAttribute("data-litsx-light-dom-style", "");
  styleElement.textContent = cssText;
  host.appendChild(styleElement);
  host[LIGHT_DOM_STYLE_ELEMENT] = styleElement;
}

function dedupeMixin(applyMixin) {
  const mixinId = Symbol("litsx.mixin");

  return (Base) => {
    if (
      Base &&
      typeof Base === "function" &&
      Base[DEDUPE_MIXIN_MARK] &&
      Base[DEDUPE_MIXIN_MARK].has(mixinId)
    ) {
      return Base;
    }

    const Mixed = applyMixin(Base);
    const marks = new Set(Base?.[DEDUPE_MIXIN_MARK] || []);
    marks.add(mixinId);
    Object.defineProperty(Mixed, DEDUPE_MIXIN_MARK, {
      value: marks,
      configurable: true,
    });
    return Mixed;
  };
}

function isPlainObject$1(value) {
  return value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype;
}

const LitsxStaticHoistsMixin = dedupeMixin((Base) =>
  class LitsxStaticHoistsHost extends Base {
    static __litsxStatic(cacheKey, compute) {
      if (!Object.prototype.hasOwnProperty.call(this, cacheKey)) {
        this[cacheKey] = compute();
      }

      return this[cacheKey];
    }

    static __litsxResolveStaticValue(value) {
      return value;
    }

    static __litsxMergeProperties(base, override) {
      if (!override) return base;

      const next = { ...(base || {}) };

      for (const key in override) {
        const baseEntry = next[key];
        const overrideEntry = override[key];

        if (isPlainObject$1(baseEntry) && isPlainObject$1(overrideEntry)) {
          next[key] = {
            ...baseEntry,
            ...overrideEntry,
          };
        } else {
          next[key] = overrideEntry;
        }
      }

      return next;
    }
  }
);

function hasScopedElements(host) {
  const elements = host?.constructor?.elements ?? host?.constructor?.scopedElements ?? {};
  return elements && typeof elements === "object" && Object.keys(elements).length > 0;
}

function assertNoScopedLightDomElements(host) {
  if (!hasScopedElements(host)) {
    return;
  }

  const ctorName = host?.constructor?.name || "LightDom component";
  throw new Error(
    `${ctorName} cannot use static elements with LightDomMixin. Scoped elements in light DOM are not supported in this runtime.`,
  );
}

function syncShadowRootCreationScope(host, shadowRoot, registry) {
  if (!host?.renderOptions) {
    return;
  }

  const canUseScopedCreationScope =
    typeof shadowRoot?.importNode === "function" &&
    typeof registry?._getDefinition === "function";

  if (canUseScopedCreationScope) {
    host.renderOptions.creationScope = shadowRoot;
    host.renderOptions.renderBefore ??= shadowRoot.firstChild;
    return;
  }

  if (host.renderOptions.creationScope === shadowRoot) {
    delete host.renderOptions.creationScope;
  }
}
function hasHydratableLitMarkers(root) {
  for (const node of root?.childNodes ?? []) {
    if (node.nodeType === 8 && /^\/?lit-|^lit-/.test(node.data ?? "")) {
      return true;
    }
  }
  return false;
}

function prepareLitHydration(host, root) {
  host._$AG = true;
  host._$needsHydration = true;

  const renderBefore = root?.firstChild ?? null;
  if (host.renderOptions && renderBefore) {
    host[HYDRATION_RENDER_BEFORE] = renderBefore;
    host.renderOptions.renderBefore ??= renderBefore;
  }
}

function clearHydrationRenderBefore(host) {
  const renderBefore = host[HYDRATION_RENDER_BEFORE];
  if (!renderBefore) {
    return;
  }

  if (host.renderOptions?.renderBefore === renderBefore) {
    delete host.renderOptions.renderBefore;
  }
  host[HYDRATION_RENDER_BEFORE] = null;
  host._$AG = false;
}
const ShadowDomMixin = dedupeMixin((Base) =>
  class ShadowDomHost extends Base {
    static get scopedElements() {
      return this.elements ?? {};
    }

    get registry() {
      return this[SHADOW_DOM_REGISTRY] ?? null;
    }

    set registry(registry) {
      this[SHADOW_DOM_REGISTRY] = registry;
    }

    createRenderRoot() {
      const existingRoot = this.shadowRoot;
      if (existingRoot) {
        prepareLitHydration(this, existingRoot);
        const rootRegistry =
          existingRoot.registry ??
          existingRoot.customElements ??
          existingRoot.customElementRegistry ??
          null;
        // A scoped native registry can only be supplied while creating a
        // shadow root. Declarative Shadow DOM already exists by hydration
        // time, so nested static elements need the shim regardless of where
        // Lit's hydration markers occur in the serialized tree.
        const shouldForceHydrationRegistry = hasScopedElements(this) && !rootRegistry;

        if (shouldForceHydrationRegistry) {
          const { registry } = createScopedRegistryForHost(this, {
            forceLightDomRegistry: true,
          });
          this.registry = registry;
          assignShadowRootRegistry$1(existingRoot, registry);
        } else if (rootRegistry) {
          this.registry = rootRegistry;
        } else {
          this.registry ??= createScopedRegistryForHost(this).registry;
          assignShadowRootRegistry$1(existingRoot, this.registry);
        }

        if (this.registry) {
          defineScopedElements$1(this.registry, this.constructor.elements ?? {});
          if (typeof this.registry._getDefinition === "function") {
            upgradeScopedRegistryTree(existingRoot, this.registry);
          } else if (typeof this.registry.upgrade === "function") {
            this.registry.upgrade(existingRoot);
          }
        }
        syncShadowRootCreationScope(this, existingRoot, this.registry);
        return existingRoot;
      }

      const ctor = this.constructor;
      if (typeof ctor.finalize === "function") {
        ctor.finalize();
      }

      const { attachKey, registry } = createScopedRegistryForHost(this);
      const scopedRegistryOption = attachKey ? { [attachKey]: registry } : {};
      const shadowRootOptions = {
        mode: "open",
        ...(ctor.shadowRootOptions ?? {}),
        ...scopedRegistryOption,
      };
      const shadowRoot = this.attachShadow(shadowRootOptions);
      if (!attachKey) {
        assignShadowRootRegistry$1(shadowRoot, registry);
      }
      syncShadowRootCreationScope(this, shadowRoot, registry);
      S(shadowRoot, ctor.elementStyles ?? []);
      return shadowRoot;
    }

    update(...args) {
      if (typeof super.update === "function") {
        super.update(...args);
      }
      clearHydrationRenderBefore(this);
      if (this.registry && typeof this.registry._getDefinition === "function") {
        upgradeScopedRegistryTree(this.shadowRoot, this.registry);
      } else if (typeof this.registry?.upgrade === "function") {
        this.registry.upgrade(this.shadowRoot);
      }
    }
  }
);

const LightDomMixin = dedupeMixin((Base) =>
  class LightDomHost extends Base {
    static [LITSX_LIGHT_DOM] = true;

    constructor(...args) {
      super(...args);
      // Light DOM remains supported as a render-root mode, but scoped element
      // resolution now belongs exclusively to the shadow-based path.
      assertNoScopedLightDomElements(this);
    }

    createRenderRoot() {
      if (hasHydratableLitMarkers(this)) {
        prepareLitHydration(this, this);
      }
      return this;
    }

    renderLight() {
      return typeof this.render === "function" ? this.render() : undefined;
    }

    connectedCallback(...args) {
      if (typeof super.connectedCallback === "function") {
        super.connectedCallback(...args);
      }
      assertNoScopedLightDomElements(this);
    }

    disconnectedCallback(...args) {
      if (typeof super.disconnectedCallback === "function") {
        super.disconnectedCallback(...args);
      }
    }

    update(...args) {
      if (typeof super.update === "function") {
        super.update(...args);
      }
      clearHydrationRenderBefore(this);
      ensureLightDomStyles(this);
    }
  }
);

const SOFT_SUSPENSE = Symbol("litsx.softSuspense");
const SUSPENSE_CAPTURE = Symbol("litsx.suspenseCapture");
let currentSoftSuspenseCollector = null;
let currentSuspenseCapture = null;

function isThenable$3(value) {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function reportAsyncError$1(error) {
  queueMicrotask(() => {
    throw error;
  });
}

function getSoftSuspenseState(host) {
  if (!host[SOFT_SUSPENSE]) {
    Object.defineProperty(host, SOFT_SUSPENSE, {
      value: {
        pendingThenable: null,
        version: 0,
      },
      configurable: true,
    });
  }
  return host[SOFT_SUSPENSE];
}

function withSuspenseCapture(capture, render) {
  const previousCapture = currentSuspenseCapture;
  currentSuspenseCapture = capture ?? null;
  try {
    return render();
  } finally {
    currentSuspenseCapture = previousCapture;
  }
}

function getCurrentSuspenseCapture() {
  return currentSuspenseCapture;
}

function setHostSuspenseCapture(host, capture) {
  if (!host || (typeof host !== "object" && typeof host !== "function")) {
    return;
  }

  if (capture == null) {
    try {
      delete host[SUSPENSE_CAPTURE];
    } catch {
      // Some host-like objects may reject deletes; leave them untouched.
    }
    return;
  }

  Object.defineProperty(host, SUSPENSE_CAPTURE, {
    value: capture,
    configurable: true,
  });
}

function getHostSuspenseCapture(host) {
  return host?.[SUSPENSE_CAPTURE] ?? null;
}

function collectSoftSuspenseThenables(collector, render) {
  // SSR renderers wrap each render pass with this collector so rootless
  // suspensions are awaitable instead of being serialized as empty output.
  const previousCollector = currentSoftSuspenseCollector;
  currentSoftSuspenseCollector = collector;
  let result;
  try {
    result = render();
  } catch (error) {
    currentSoftSuspenseCollector = previousCollector;
    throw error;
  }

  if (isThenable$3(result)) {
    return Promise.resolve(result).finally(() => {
      currentSoftSuspenseCollector = previousCollector;
    });
  }

  currentSoftSuspenseCollector = previousCollector;
  return result;
}

function collectSuspenseThenable(thenable) {
  if (!currentSoftSuspenseCollector || !isThenable$3(thenable)) {
    return null;
  }

  const promise = Promise.resolve(thenable);
  currentSoftSuspenseCollector.add(promise);
  return promise;
}

function renderWithSoftSuspense(host, render) {
  try {
    return render();
  } catch (thrown) {
    if (!isThenable$3(thrown)) {
      throw thrown;
    }

    const capture = getCurrentSuspenseCapture() ?? getHostSuspenseCapture(host);
    if (capture && typeof capture.capture === "function") {
      capture.capture(thrown);
      return A;
    }

    const state = getSoftSuspenseState(host);
    const promise = collectSuspenseThenable(thrown) ?? Promise.resolve(thrown);

    if (state.pendingThenable === thrown) {
      return A;
    }

    const version = state.version + 1;
    state.version = version;
    state.pendingThenable = thrown;
    state.pendingPromise = promise;
    promise.then(
      () => {
        if (state.version !== version) {
          return;
        }
        state.pendingThenable = null;
        state.pendingPromise = null;
        host?.requestUpdate?.();
      },
      (error) => {
        if (state.version !== version) {
          return;
        }
        state.pendingThenable = null;
        state.pendingPromise = null;
        host?.requestUpdate?.();
        reportAsyncError$1(error);
      }
    );

    return A;
  }
}

const SSR_RUNTIME_STATE_ACCESS = Symbol.for("litsx.ssr.runtimeStateAccess");
const SSR_RUNTIME_STATE_STACK = Symbol.for("litsx.ssr.runtimeStateStack");

function getRuntimeStateAccess() {
  const access = globalThis[SSR_RUNTIME_STATE_ACCESS];
  if (
    !access ||
    typeof access.getStore !== "function" ||
    typeof access.run !== "function"
  ) {
    return null;
  }

  return access;
}

function getRuntimeStateStack() {
  globalThis[SSR_RUNTIME_STATE_STACK] ??= [];
  return globalThis[SSR_RUNTIME_STATE_STACK];
}

function getCurrentSsrRuntimeState() {
  const access = getRuntimeStateAccess();
  if (access) {
    return access.getStore() ?? null;
  }

  return getRuntimeStateStack().at(-1) ?? null;
}

function getCurrentSsrCustomElementInstanceStack() {
  return getCurrentSsrRuntimeState()?.customElementInstanceStack ?? null;
}

function getCurrentExecutionContextInternal() {
  return getCurrentSsrRuntimeState()?.executionContext ?? null;
}

/**
 * Rendering helpers used by LitSX transforms when authored JSX passes renderer
 * functions across component boundaries.
 *
 * This module is a public runtime subpath for generated code. It keeps renderer
 * callbacks associated with the host and scoped-registry creation context that
 * produced them, so projected content can render custom elements consistently.
 */

const RENDERER_CONTEXT = Symbol("litsx.rendererContext");
const RENDERER_HOST_INITIALIZED = Symbol("litsx.rendererHostInitialized");
const RENDERER_MOUNT_HOST = Symbol("litsx.rendererMountHost");
const RENDERER_MOUNT_ROOT = Symbol("litsx.rendererMountRoot");
const RENDERER_MOUNT_ELEMENTS = Symbol("litsx.rendererMountElements");
const RENDERER_SHADOW_CONTAINER = Symbol("litsx.rendererShadowContainer");
const PROJECTED_LIGHT_DOM_ATTRIBUTE = "data-litsx-projected-root";
let rendererRegistryAttachKey;
let rendererRegistryAttachShadowRef;
let rendererRegistryCtorRef;
let rendererRegistryNativeSupport;

const RENDERER_SSR_VALUE_ERROR =
  "SSR renderer props must return a renderable TemplateResult, not a server component call or scoped template.";

function getElementAttachShadowRef() {
  return typeof Element !== "undefined" ? Element.prototype.attachShadow : undefined;
}

function isShadowRootContainer(value) {
  return (
    (typeof ShadowRoot !== "undefined" && value instanceof ShadowRoot) ||
    value?.[RENDERER_SHADOW_CONTAINER] === true
  );
}

function resolveStrictSyncSsrRenderableValue(value) {
  if (__isLitsxServerComponentCall(value) || __isLitsxScopedTemplate(value)) {
    throw new Error(RENDERER_SSR_VALUE_ERROR);
  }

  if (l(value)) {
    return {
      ...value,
      values: value.values.map((entry) => resolveStrictSyncSsrRenderableValue(entry)),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveStrictSyncSsrRenderableValue(entry));
  }

  return value;
}

// Renderer props remain a synchronous projection mechanism in SSR.
// They may return normal renderable values such as TemplateResult trees,
// but not async server-component calls or scoped-template envelopes.
function resolveRendererSsrValue(value) {
  return resolveStrictSyncSsrRenderableValue(value);
}

function resolveRendererSsrValueWithContext(value, ssrContext) {
  if (!ssrContext) {
    return value;
  }

  if (l(value)) {
    const values = value.values.map((entry) =>
      resolveRendererSsrValueWithContext(entry, ssrContext)
    );
    return {
      ...value,
      values,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveRendererSsrValueWithContext(entry, ssrContext));
  }

  return resolveRendererSsrValue(value);
}

function captureCreationScope(host) {
  if (!host || typeof host !== "object") {
    return null;
  }

  if (host.renderOptions?.creationScope) {
    return host.renderOptions.creationScope;
  }

  if (host.shadowRoot && typeof host.shadowRoot.importNode === "function") {
    return host.shadowRoot;
  }

  return null;
}

function getContextualElements(context) {
  const ctor = context?.host?.constructor;
  if (!ctor || typeof ctor !== "function") {
    return null;
  }

  const elements = ctor.scopedElements ?? ctor.elements ?? null;
  return elements && typeof elements === "object" ? elements : null;
}

function getContextualStyles(context) {
  const styles = context?.host?.constructor?.elementStyles;
  return Array.isArray(styles) ? styles : [];
}

function hasSameElementDefinitions(previousElements, nextElements) {
  const previousEntries = Object.entries(previousElements || {});
  const nextEntries = Object.entries(nextElements || {});
  if (previousEntries.length !== nextEntries.length) {
    return false;
  }

  return nextEntries.every(([tagName, ctor]) => previousElements?.[tagName] === ctor);
}

function getRendererRegistryAttachKey() {
  if (
    rendererRegistryAttachKey !== undefined &&
    rendererRegistryAttachShadowRef === getElementAttachShadowRef() &&
    rendererRegistryCtorRef === globalThis.CustomElementRegistry &&
    rendererRegistryNativeSupport !== undefined
  ) {
    return rendererRegistryAttachKey;
  }

  if (
    typeof document === "undefined" ||
    typeof CustomElementRegistry !== "function" ||
    typeof Element === "undefined"
  ) {
    rendererRegistryAttachKey = null;
    rendererRegistryAttachShadowRef = getElementAttachShadowRef();
    rendererRegistryCtorRef = globalThis.CustomElementRegistry;
    rendererRegistryNativeSupport = false;
    return null;
  }

  let registry;
  try {
    registry = new CustomElementRegistry();
  } catch {
    rendererRegistryAttachKey = null;
    rendererRegistryAttachShadowRef = getElementAttachShadowRef();
    rendererRegistryCtorRef = globalThis.CustomElementRegistry;
    rendererRegistryNativeSupport = false;
    return null;
  }

  for (const key of ["registry", "customElements", "customElementRegistry"]) {
    const host = document.createElement("div");
    try {
      const shadowRoot = host.attachShadow({
        mode: "open",
        [key]: registry,
      });
      if (shadowRoot?.[key] === registry) {
        const supportKey = `litsx-renderer-support-${Math.random().toString(36).slice(2)}`;
        class SupportElement extends HTMLElement {}
        try {
          registry.define(supportKey, SupportElement);
          shadowRoot.innerHTML = `<${supportKey}></${supportKey}>`;
          const upgraded = shadowRoot.querySelector(supportKey);
          rendererRegistryNativeSupport = Object.getPrototypeOf(upgraded) === SupportElement.prototype;
        } catch {
          rendererRegistryNativeSupport = false;
        }

        rendererRegistryAttachKey = rendererRegistryNativeSupport ? key : null;
        rendererRegistryAttachShadowRef = getElementAttachShadowRef();
        rendererRegistryCtorRef = globalThis.CustomElementRegistry;
        return rendererRegistryAttachKey;
      }
    } catch {
      // Try the next known attach option.
    }
  }

  rendererRegistryAttachKey = null;
  rendererRegistryAttachShadowRef = getElementAttachShadowRef();
  rendererRegistryCtorRef = globalThis.CustomElementRegistry;
  rendererRegistryNativeSupport = false;
  return null;
}

function defineScopedElements(registry, elements = {}) {
  for (const [tagName, elementClass] of Object.entries(elements)) {
    if (!tagName || typeof elementClass !== "function") {
      continue;
    }

    const existing = registry.get?.(tagName) ?? null;
    if (existing === elementClass) {
      continue;
    }

    if (existing && existing !== elementClass) {
      throw new Error(
        `Projected renderer host cannot redefine scoped element "${tagName}" with a different constructor.`,
      );
    }

    registry.define(tagName, elementClass);
  }
}

function assignShadowRootRegistry(shadowRoot, registry) {
  for (const key of ["registry", "customElements", "customElementRegistry"]) {
    try {
      shadowRoot[key] = registry;
    } catch {
      // Ignore readonly experimental aliases.
    }
  }
}

function createRendererMount(host, context) {
  const attachKey = getRendererRegistryAttachKey();
  const elements = getContextualElements(context) ?? {};
  const hasScopedElements = Object.keys(elements).length > 0;
  const mountHost = host.ownerDocument.createElement("div");
  mountHost.style.display = "contents";

  let registry = null;
  const useNativeScopedRegistry =
    hasScopedElements &&
    Boolean(attachKey) &&
    typeof CustomElementRegistry === "function";

  const shadowRoot = mountHost.attachShadow({
    mode: "open",
    ...(useNativeScopedRegistry ? { [attachKey]: new CustomElementRegistry() } : {}),
  });
  shadowRoot[RENDERER_SHADOW_CONTAINER] = true;

  if (useNativeScopedRegistry) {
    registry = shadowRoot[attachKey] ?? null;
    defineScopedElements(registry, elements);
    assignShadowRootRegistry(shadowRoot, registry);
  } else if (hasScopedElements) {
    registry = createLightDomRegistry(shadowRoot, {});
    defineScopedElements(registry, elements);
  }

  S(shadowRoot, getContextualStyles(context));

  mountHost[RENDERER_MOUNT_ROOT] = shadowRoot;
  mountHost[RENDERER_MOUNT_ELEMENTS] = { ...elements };
  host.appendChild(mountHost);
  host[RENDERER_MOUNT_HOST] = mountHost;
  return mountHost;
}

function ensureRendererMount(host, context) {
  const elements = getContextualElements(context) ?? {};
  let mountHost = host[RENDERER_MOUNT_HOST] ?? null;

  if (
    mountHost &&
    !hasSameElementDefinitions(mountHost[RENDERER_MOUNT_ELEMENTS], elements)
  ) {
    D(A, mountHost[RENDERER_MOUNT_ROOT] ?? mountHost);
    mountHost.remove();
    mountHost = null;
    host[RENDERER_MOUNT_HOST] = null;
  }

  if (!mountHost) {
    mountHost = createRendererMount(host, context);
  }

  const shadowRoot = mountHost?.[RENDERER_MOUNT_ROOT] ?? null;
  if (!shadowRoot) {
    return null;
  }

  S(shadowRoot, getContextualStyles(context));
  return shadowRoot;
}

function clearRendererMount(host) {
  const mountHost = host?.[RENDERER_MOUNT_HOST] ?? null;
  if (!mountHost) {
    return;
  }

  D(A, mountHost[RENDERER_MOUNT_ROOT] ?? mountHost);
  mountHost.remove?.();
  host[RENDERER_MOUNT_HOST] = null;
}

function getScopedRegistry(scope) {
  for (const key of ["registry", "customElements", "customElementRegistry"]) {
    const registry = scope?.[key];
    if (
      registry &&
      typeof registry.define === "function" &&
      typeof registry.get === "function"
    ) {
      return registry;
    }
  }

  return null;
}

function resolveContextCreationScope(context) {
  if (!context?.host) {
    return null;
  }

  if (context.creationScope) {
    return context.creationScope;
  }

  const creationScope = captureCreationScope(context.host);
  if (creationScope) {
    context.creationScope = creationScope;
  }
  return creationScope;
}

function hasExternalScopedRegistry(scope) {
  const registry = getScopedRegistry(scope);
  return Boolean(registry && typeof registry._getDefinition !== "function");
}

function prefersDirectProjectedLightDom(host) {
  return host?.getAttribute?.(PROJECTED_LIGHT_DOM_ATTRIBUTE) === "light";
}

function shouldUseProjectedLightDom(host, context) {
  if (!context?.projected) {
    return false;
  }

  if (prefersDirectProjectedLightDom(host)) {
    return true;
  }

  return resolveContextCreationScope(context) == null;
}

function invokeRenderer(renderer, ...args) {
  if (typeof renderer !== "function") {
    return {
      value: A,
      context: null,
      projected: false,
    };
  }

  const context = renderer[RENDERER_CONTEXT] ?? null;
  const render = () => renderer(...args);
  if (context?.projected) {
    return {
      value: render() ?? A,
      context,
      projected: true,
    };
  }
  const creationScope = resolveContextCreationScope(context);
  const value = !context?.host
    ? render()
    : hasExternalScopedRegistry(creationScope)
      ? render()
      : withLightDomCreationContext(context?.host ?? null, render);
  return {
    value: value ?? A,
    context,
    projected: Boolean(context?.projected),
  };
}

function resolveRenderedValueForSsr(rendered) {
  if (!rendered) {
    return A;
  }

  const currentSsrEntry = getCurrentSsrCustomElementInstanceStack()?.at(-1) ?? null;
  const currentSsrHost = currentSsrEntry?.element ?? currentSsrEntry ?? null;
  const ssrContext = currentSsrHost?.[LITSX_SSR_CONTEXT]?.context ?? null;

  return resolveRendererSsrValueWithContext(rendered.value ?? A, ssrContext);
}

function renderWithRendererContext(render, container, value, context, options = {}) {
  const resolvedRenderMode = isShadowRootContainer(container) ? "shadow" : "light";

  if (resolvedRenderMode === "shadow") {
    return render(value, container, {
      ...options,
      renderMode: resolvedRenderMode,
      ...(context?.host ? { host: context.host } : {}),
    });
  }

  const creationScope = resolveContextCreationScope(context);
  const projectedCreationHost = context?.projected
    ? options.creationContextHost ?? null
    : null;
  const { creationContextHost, ...renderOptions } = options;
  const renderValue = () =>
    render(value, container, {
      ...renderOptions,
      renderMode: resolvedRenderMode,
      ...(context?.host ? { host: context.host } : {}),
      ...(creationScope && !projectedCreationHost ? { creationScope } : {}),
    });

  return !context?.host
    ? renderValue()
    : projectedCreationHost
      ? withLightDomCreationContext(projectedCreationHost, renderValue)
    : hasExternalScopedRegistry(creationScope)
      ? renderValue()
      : withLightDomCreationContext(context?.host ?? null, renderValue);
}

function syncRendererHost(
  host,
  rendered,
  {
    render,
    visible = true,
  }
) {
  if (!host || typeof render !== "function") {
    return;
  }

  const useProjectedLightDom = shouldUseProjectedLightDom(
    host,
    rendered?.context ?? null,
  );
  const useShadowMount =
    rendered?.context?.projected &&
    !useProjectedLightDom;

  const rendererRoot = useShadowMount
    ? ensureRendererMount(host, rendered?.context ?? null)
    : null;
  if (!useShadowMount) {
    clearRendererMount(host);
  }
  const creationContextHost =
    useProjectedLightDom
      ? rendered?.context?.host ?? host
      : host;
  host.hidden = !visible;
  if (!visible && !rendered?.context && !host[RENDERER_HOST_INITIALIZED]) {
    return;
  }
  renderWithRendererContext(
    render,
    rendererRoot ?? host,
    visible ? rendered?.value ?? A : A,
    rendered?.context ?? null,
    { creationContextHost },
  );
  host[RENDERER_HOST_INITIALIZED] = true;
}

function isThenable$2(value) {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function isSsrHost$1(host) {
  return Boolean(host?.[LITSX_SSR_CONTEXT]);
}

/**
 * Catch synchronous render errors for one subtree and render fallback UI instead.
 * ErrorBoundary is the native Lit<sup>sx</sup> primitive for recoverable render failures.
 * Think of ErrorBoundary as the point where one part of the UI is allowed to fail without taking down the whole component.
 * @usage Wrap a subtree that may throw during render and provide fallback content that should replace it on failure.
 * @usage Keep the boundary close to the risky region so the fallback stays specific to the part of the UI that failed.
 * @usage Recreate the boundary with a new identity when you want to retry after a latched failure.
 * @behavior The boundary catches synchronous render errors from its content renderer and switches to fallback mode.
 * @behavior Once it has failed, the boundary stays latched on fallback until the instance is replaced.
 * @behavior Thenables are not treated as errors. They are rethrown so SuspenseBoundary can continue to own asynchronous reveal.
 * @behavior ErrorBoundary renders fallback and content in light DOM wrappers so authored subtrees keep the render context of the host that declared them.
 * @mentalModel An ErrorBoundary says: if this part of the tree throws, show this fallback instead and keep the rest of the UI alive.
 * @pitfall Do not expect the boundary to retry automatically after failure. Replace the instance through identity when you want a fresh attempt.
 * @pitfall Keep fallback UI focused on recovery. It should explain failure or provide a next action, not silently hide the problem.
 * @example
 * <ErrorBoundary fallback={<span>Could not load profile.</span>}>
 *   <ProfilePanel />
 * </ErrorBoundary>
 */
class ErrorBoundary extends LightDomMixin(i) {
  static [Symbol.for("litsx.component")] = true;

  static properties = {
    failed: { type: Boolean, reflect: true },
    error: { attribute: false },
    onError: { attribute: false },
    fallback: { attribute: false },
    content: { attribute: false },
  };

  constructor() {
    super();
    this.failed = false;
    this.error = null;
    this.onError = null;
    this.fallback = null;
    this.content = null;
    this._contentHostState = null;
    this._fallbackHostState = null;
    this._contentVisible = true;
    this._fallbackVisible = false;
  }

  renderFallback() {
    const {
      value: fallback = A,
      context: fallbackContext = null,
      projected: fallbackProjected = false,
    } = invokeRenderer(
      this.fallback,
      this.error,
    );
    this._contentHostState = null;
    this._fallbackHostState = {
      value: fallback,
      context: fallbackContext,
      projected: fallbackProjected,
    };
    this._contentVisible = false;
    this._fallbackVisible = true;

    return this.renderHosts();
  }

  render() {
    if (this.failed) {
      return this.renderFallback();
    }

    try {
      const {
        value: content = A,
        context: contentContext = null,
        projected: contentProjected = false,
      } = invokeRenderer(
        this.content,
      );

      this.error = null;
      this.failed = false;
      this._fallbackHostState = null;
      this._contentHostState = {
        value: content,
        context: contentContext,
        projected: contentProjected,
      };
      this._contentVisible = true;
      this._fallbackVisible = false;
      return this.renderHosts();
    } catch (thrown) {
      if (isThenable$2(thrown)) {
        throw thrown;
      }

      const shouldNotify = !this.failed;
      this.failed = true;
      this.error = thrown;

      if (shouldNotify && typeof this.onError === "function") {
        try {
          this.onError(thrown);
        } catch (callbackError) {
          this.reportError?.(callbackError);
        }
      }

      return this.renderFallback();
    }
  }

  updated() {
    const contentHost = this.querySelector('[data-litsx-error-region="content"]');
    const fallbackHost = this.querySelector('[data-litsx-error-region="fallback"]');

    syncRendererHost(contentHost, this._contentHostState, {
      render: D,
      visible: this._contentVisible,
    });
    syncRendererHost(fallbackHost, this._fallbackHostState, {
      render: D,
      visible: this._fallbackVisible,
    });
  }

  renderHosts() {
    const fallbackContent = isSsrHost$1(this) && this._fallbackVisible
      ? resolveRenderedValueForSsr(this._fallbackHostState)
      : A;
    const contentContent = isSsrHost$1(this) && this._contentVisible
      ? resolveRenderedValueForSsr(this._contentHostState)
      : A;

    return b`
      <div
        part="fallback"
        data-litsx-error-region="fallback"
        data-litsx-projected-root="light"
        data-showing="fallback"
        ?hidden=${!this._fallbackVisible}
      >${fallbackContent}</div>
      <div
        part="content"
        data-litsx-error-region="content"
        data-litsx-projected-root="light"
        data-showing="content"
        ?hidden=${!this._contentVisible}
      >${contentContent}</div>
    `;
  }
}

function isThenable$1(value) {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function reportAsyncError(error) {
  queueMicrotask(() => {
    throw error;
  });
}

function isSsrHost(host) {
  return Boolean(host?.[LITSX_SSR_CONTEXT]);
}

/**
 * Define a fallback boundary around a subtree that may suspend.
 * SuspenseBoundary is the native Lit<sup>sx</sup> primitive for asynchronous UI coordination.
 * Think of SuspenseBoundary as the point where one part of the UI is allowed to wait without blocking the whole component.
 * @usage Wrap the part of the UI that may pause while data, code, or a deferred element becomes available.
 * @usage Provide fallback content that should be rendered while the boundary is waiting.
 * @usage Keep the boundary close to the asynchronous region so the fallback stays specific to the part of the UI that is actually pending.
 * @usage Prefer several small boundaries over one large catch-all boundary when different areas of the UI can resolve independently.
 * @behavior The boundary renders fallback content while the wrapped subtree is pending.
 * @behavior Once the subtree resolves, the boundary can coordinate its reveal with a parent SuspenseList.
 * @behavior SuspenseBoundary renders fallback and content in light DOM wrappers so authored subtrees keep the render context of the host that declared them.
 * @behavior The fallback is part of the authored component tree, so it can use the same JSX patterns and styling approach as the rest of the component.
 * @mentalModel A SuspenseBoundary says: this part of the tree may pause, and this is the UI that should stand in while it catches up.
 * @pitfall Avoid wrapping large unrelated sections in a single boundary. Smaller, focused boundaries usually produce clearer fallbacks and better reveal behavior.
 * @pitfall Fallback UI should stay lightweight and recognizable. Treat it as temporary stand-in content, not as a second full version of the screen.
 * @example
 * <SuspenseBoundary fallback={<span>Loading profile...</span>}>
 *   <UserProfile />
 * </SuspenseBoundary>
 */
class SuspenseBoundary extends LightDomMixin(i) {
  static [Symbol.for("litsx.component")] = true;

  static properties = {
    pending: { type: Boolean, reflect: true },
    resolved: { type: Boolean, reflect: true },
    showing: { type: String, reflect: true },
    phase: { type: String, reflect: true },
    fallback: { attribute: false },
    content: { attribute: false },
  };

  constructor() {
    super();
    this.pending = false;
    this.resolved = false;
    this.showing = "content";
    this.phase = "content";
    this.fallback = null;
    this.content = null;

    this._version = 0;
    this._pendingPromise = null;
    this._lastContent = A;
    this._lastContentRender = null;
    this._displayValue = A;
    this._lastFallback = A;
    this._lastFallbackRender = null;
    this._contentVisible = true;
    this._fallbackVisible = false;
    this._contentHostState = null;
    this._fallbackHostState = null;
    this._suspenseList = null;
    this._revealToken = 0;
    this._isRevealing = false;
    this._revealTimeout = null;
    this._lastListSnapshot = "";
    this._contentSuspenseCapture = {
      capture: (thenable) => this.captureContentSuspension(thenable),
    };
    this._fallbackSuspenseCapture = {
      capture: (thenable) => this.captureFallbackSuspension(thenable),
    };
    this._fallbackSuspendedDuringRender = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.attachToSuspenseList();
    queueMicrotask(() => {
      if (this._suspenseList == null) {
        this.attachToSuspenseList();
      }
    });
    this.addEventListener("transitionend", this);
    this.addEventListener("animationend", this);
  }

  disconnectedCallback() {
    this.detachFromSuspenseList();
    this.removeEventListener("transitionend", this);
    this.removeEventListener("animationend", this);
    super.disconnectedCallback();
    this._version += 1;
    this.pending = false;
    this.resolved = false;
    this.showing = "content";
    this.phase = "content";
    this._pendingPromise = null;
    this._lastContent = A;
    this._lastContentRender = null;
    this._displayValue = A;
    this._lastFallback = A;
    this._lastFallbackRender = null;
    this._contentVisible = true;
    this._fallbackVisible = false;
    this._contentHostState = null;
    this._fallbackHostState = null;
    this._lastListSnapshot = "";
    this._revealToken += 1;
    this._isRevealing = false;
    this.clearRevealTimeout();
  }

  render() {
    if (this._suspenseList == null) {
      this.attachToSuspenseList();
    }

    try {
      const {
        value: resolvedContent = A,
        context: contentContext = null,
        projected: contentProjected = false,
      } = this.withContentSuspenseCapture(() =>
        invokeRenderer(this.content)
      );
      const content = resolvedContent ?? A;
      const contentRender = {
        value: content,
        context: contentContext,
        projected: contentProjected,
      };
      const contentDisposition = this._suspenseList
        ? this._suspenseList.getContentDisposition(this)
        : "content";
      const {
        value: resolvedFallback = A,
        context: fallbackContext = null,
        projected: fallbackProjected = false,
      } = this.invokeFallbackRenderer();
      const fallback = resolvedFallback ?? A;
      const fallbackRender = {
        value: fallback,
        context: fallbackContext,
        projected: fallbackProjected,
      };
      if (this._fallbackSuspendedDuringRender) {
        return this.renderHosts();
      }

      if (this._pendingPromise) {
        this._lastContent = content;
        this._lastContentRender = contentRender;
        return this.applyPendingFallbackRender(fallbackRender);
      }

      this._pendingPromise = null;
      this._lastContent = content;
      this._lastContentRender = contentRender;
      this.pending = false;
      this.resolved = true;
      if (contentDisposition === "fallback") {
        this._displayValue = fallback;
        this._lastFallback = fallback;
        this._lastFallbackRender = fallbackRender;
        this.showing = "fallback";
        this.phase = "blocked";
        this._contentHostState = contentRender;
        this._fallbackHostState = fallbackRender;
        this._contentVisible = false;
        this._fallbackVisible = true;
        this.notifyListState();
        return this.renderHosts();
      }

      if (contentDisposition === "hidden") {
        this._displayValue = A;
        this.showing = "hidden";
        this.phase = "hidden";
        this._contentHostState = contentRender;
        this._fallbackHostState = fallbackRender;
        this._contentVisible = false;
        this._fallbackVisible = false;
        this.notifyListState();
        return this.renderHosts();
      }

      if (this._isRevealing) {
        this._displayValue = content;
        this.showing = "content";
        this.phase = "revealing";
        this._contentHostState = contentRender;
        this._fallbackHostState = this._lastFallbackRender ?? fallbackRender;
        this._contentVisible = true;
        this._fallbackVisible = true;
        this.notifyListState();
        return this.renderHosts();
      }

      if (
        this.showing === "fallback" &&
        this._lastFallback !== A
      ) {
        this.beginReveal();
        this._displayValue = content;
        this.showing = "content";
        this.phase = "revealing";
        this._contentHostState = contentRender;
        this._fallbackHostState = this._lastFallbackRender ?? fallbackRender;
        this._contentVisible = true;
        this._fallbackVisible = true;
        this.notifyListState();
        return this.renderHosts();
      }

      this._displayValue = content;
      this.showing = "content";
      this.phase = "content";
      this._contentHostState = contentRender;
      this._fallbackHostState = fallbackRender;
      this._contentVisible = true;
      this._fallbackVisible = false;
      this.notifyListState();
      return this.renderHosts();
    } catch (thrown) {
      if (!isThenable$1(thrown)) {
        reportAsyncError(thrown);
        return A;
      }

      return this.handleSuspension(thrown);
    }
  }

  updated() {
    const contentHost = this.querySelector('[data-litsx-suspense-region="content"]');
    const fallbackHost = this.querySelector('[data-litsx-suspense-region="fallback"]');

    try {
      this.syncRenderedHost(
        contentHost,
        this._contentHostState,
        this._contentVisible,
        this._contentSuspenseCapture,
      );
    } catch (thrown) {
      if (!isThenable$1(thrown)) {
        reportAsyncError(thrown);
        return;
      }

      this.handleSuspension(thrown);
      this.requestUpdate();
    }

    try {
      this.syncRenderedHost(
        fallbackHost,
        this._fallbackHostState,
        this._fallbackVisible,
        this._fallbackSuspenseCapture,
      );
    } catch (thrown) {
      if (!isThenable$1(thrown)) {
        reportAsyncError(thrown);
        return;
      }

      this.handleFallbackSuspension(thrown);
      this.requestUpdate();
    }
  }

  syncRenderedHost(host, rendered, visible, capture) {
    withSuspenseCapture(capture, () => {
      syncRendererHost(host, rendered, {
        render: D,
        visible,
      });
      this.propagateSuspenseCapture(host, capture);
    });
  }

  createFallbackRender() {
    const {
      value: resolvedFallback = A,
      context: fallbackContext = null,
      projected: fallbackProjected = false,
    } = this.invokeFallbackRenderer();
    const fallback = resolvedFallback ?? A;
    return {
      value: fallback,
      context: fallbackContext,
      projected: fallbackProjected,
    };
  }

  handleSuspension(thrown) {
    this.attachPendingPromise(
      collectSuspenseThenable(thrown) ?? Promise.resolve(thrown)
    );

    let fallbackRender;
    try {
      fallbackRender = this.createFallbackRender();
      if (this._fallbackSuspendedDuringRender) {
        return this.renderHosts();
      }
    } catch (fallbackThrown) {
      if (!isThenable$1(fallbackThrown)) {
        reportAsyncError(fallbackThrown);
        return A;
      }

      this.handleFallbackSuspension(fallbackThrown);
      return this.renderHosts();
    }

    const fallback = fallbackRender.value ?? A;
    return this.applyPendingFallbackRender(fallbackRender, fallback);
  }

  applyPendingFallbackRender(fallbackRender, fallback = fallbackRender?.value ?? A) {
    this.pending = true;
    this._lastFallback = fallback;
    this._lastFallbackRender = fallbackRender;
    if (isSsrHost(this)) {
      this._displayValue = A;
      this.showing = "hidden";
      this.phase = "pending";
      this._contentHostState = this._lastContentRender;
      this._fallbackHostState = fallbackRender;
      this._contentVisible = false;
      this._fallbackVisible = false;
      this.notifyListState();
      return this.renderHosts();
    }

    const disposition = this._suspenseList
      ? this._suspenseList.getFallbackDisposition(this)
      : "show";

    if (disposition === "show") {
      this._displayValue = fallback;
      this.showing = "fallback";
      this.phase = "pending";
      this._contentHostState = this._lastContentRender;
      this._fallbackHostState = fallbackRender;
      this._contentVisible = false;
      this._fallbackVisible = true;
      this.notifyListState();
      return this.renderHosts();
    }

    if (disposition === "collapsed" && this.resolved) {
      this._displayValue = this._lastContent;
      this.showing = "content";
      this.phase = "content";
      this._contentHostState = this._lastContentRender;
      this._fallbackHostState = fallbackRender;
      this._contentVisible = true;
      this._fallbackVisible = false;
      this.notifyListState();
      return this.renderHosts();
    }

    this._displayValue = A;
    this.showing = "hidden";
    this.phase = "hidden";
    this._contentHostState = this._lastContentRender;
    this._fallbackHostState = fallbackRender;
    this._contentVisible = false;
    this._fallbackVisible = false;
    this.notifyListState();
    return this.renderHosts();
  }

  handleFallbackSuspension(thrown) {
    this.attachPendingPromise(
      collectSuspenseThenable(thrown) ?? Promise.resolve(thrown)
    );
    this.pending = true;
    this._displayValue = A;
    this.showing = "hidden";
    this.phase = "pending";
    this._contentVisible = false;
    this._fallbackVisible = false;
    this.notifyListState();
  }

  captureContentSuspension(thrown) {
    this.handleSuspension(thrown);
    this.requestUpdate();
  }

  captureFallbackSuspension(thrown) {
    this._fallbackSuspendedDuringRender = true;
    this.handleFallbackSuspension(thrown);
    this.requestUpdate();
  }

  withContentSuspenseCapture(render) {
    return withSuspenseCapture(this._contentSuspenseCapture, render);
  }

  withFallbackSuspenseCapture(render) {
    return withSuspenseCapture(this._fallbackSuspenseCapture, render);
  }

  invokeFallbackRenderer() {
    this._fallbackSuspendedDuringRender = false;
    return this.withFallbackSuspenseCapture(() =>
      invokeRenderer(this.fallback)
    );
  }

  propagateSuspenseCapture(host, capture) {
    if (!host) {
      return;
    }

    const pending = [host];
    while (pending.length > 0) {
      const current = pending.shift();
      setHostSuspenseCapture(current, capture);

      if (typeof current.querySelectorAll === "function") {
        for (const element of current.children ?? []) {
          pending.push(element);
        }
      }

      if (current.shadowRoot) {
        pending.push(current.shadowRoot);
      }

      if (current instanceof ShadowRoot) {
        for (const element of current.children ?? []) {
          pending.push(element);
        }
      }
    }
  }

  renderHosts() {
    const fallbackContent = isSsrHost(this) && this._fallbackVisible
      ? resolveRenderedValueForSsr(this._fallbackHostState)
      : A;
    const contentContent = isSsrHost(this) && this._contentVisible
      ? resolveRenderedValueForSsr(this._contentHostState)
      : A;

    return b`
      <div
        part="fallback"
        data-litsx-suspense-region="fallback"
        data-litsx-projected-root="light"
        data-showing="fallback"
        ?hidden=${!this._fallbackVisible}
        data-phase=${this.phase}
      >${fallbackContent}</div>
      <div
        part="content"
        data-litsx-suspense-region="content"
        data-litsx-projected-root="light"
        data-showing="content"
        ?hidden=${!this._contentVisible}
        data-phase=${this.phase}
      >${contentContent}</div>
    `;
  }

  beginReveal() {
    if (this._isRevealing) {
      return;
    }

    const token = ++this._revealToken;
    this._isRevealing = true;
    this.clearRevealTimeout();

    if (!this.hasActiveRevealMotion()) {
      queueMicrotask(() => {
        this.completeReveal(token);
      });
      return;
    }

    const timeoutMs = this.getRevealMotionTimeout();
    this._revealTimeout = setTimeout(() => {
      this.completeReveal(token);
    }, timeoutMs);
  }

  handleEvent(event) {
    if (!this._isRevealing) {
      return;
    }

    if (
      event?.type === "transitionend" ||
      event?.type === "animationend"
    ) {
      this.completeReveal(this._revealToken);
    }
  }

  hasActiveRevealMotion() {
    if (typeof globalThis.getComputedStyle !== "function") {
      return false;
    }

    const styles = globalThis.getComputedStyle(this);
    return (
      this.getMaxAnimationTime(styles) > 0 ||
      this.getMaxTransitionTime(styles) > 0
    );
  }

  getRevealMotionTimeout() {
    if (typeof globalThis.getComputedStyle !== "function") {
      return 32;
    }

    const styles = globalThis.getComputedStyle(this);
    const maxDuration = Math.max(
      this.getMaxAnimationTime(styles),
      this.getMaxTransitionTime(styles)
    );

    return Math.max(32, Math.ceil(maxDuration) + 50);
  }

  getMaxAnimationTime(styles) {
    return this.getMaxTimePair(
      styles?.animationDuration,
      styles?.animationDelay
    );
  }

  getMaxTransitionTime(styles) {
    return this.getMaxTimePair(
      styles?.transitionDuration,
      styles?.transitionDelay
    );
  }

  getMaxTimePair(durationValue, delayValue) {
    const durations = this.parseTimeList(durationValue);
    const delays = this.parseTimeList(delayValue);
    const size = Math.max(durations.length, delays.length);
    let max = 0;

    for (let index = 0; index < size; index += 1) {
      const duration = durations[index] ?? durations[durations.length - 1] ?? 0;
      const delay = delays[index] ?? delays[delays.length - 1] ?? 0;
      max = Math.max(max, duration + delay);
    }

    return max;
  }

  parseTimeList(value) {
    if (typeof value !== "string" || value.trim() === "") {
      return [0];
    }

    return value.split(",").map((entry) => {
      const trimmed = entry.trim();
      if (trimmed.endsWith("ms")) {
        return Number.parseFloat(trimmed.slice(0, -2)) || 0;
      }
      if (trimmed.endsWith("s")) {
        return (Number.parseFloat(trimmed.slice(0, -1)) || 0) * 1000;
      }
      return 0;
    });
  }

  completeReveal(token = this._revealToken) {
    if (!this._isRevealing || token !== this._revealToken) {
      return;
    }

    this._isRevealing = false;
    this.clearRevealTimeout();
    this.phase = "content";
    this.requestUpdate();
  }

  clearRevealTimeout() {
    if (this._revealTimeout == null) {
      return;
    }
    clearTimeout(this._revealTimeout);
    this._revealTimeout = null;
  }

  attachPendingPromise(promise) {
    if (this._pendingPromise === promise) {
      return;
    }

    const token = ++this._version;
    this._pendingPromise = promise;

    promise.then(
      () => {
        if (token !== this._version) {
          return;
        }
        this._pendingPromise = null;
        this.pending = false;
        this.requestUpdate();
      },
      (error) => {
        if (token !== this._version) {
          return;
        }
        this._pendingPromise = null;
        this.pending = false;
        this.notifyListErrored();
        reportAsyncError(error);
      }
    );
  }

  notifyListState() {
    const snapshot = `${this.pending}:${this.resolved}:${this.showing}`;
    if (snapshot === this._lastListSnapshot) {
      return;
    }
    this._lastListSnapshot = snapshot;

    if (this.pending) {
      this._suspenseList?.notifyBoundaryPending(this);
      return;
    }

    if (this.resolved) {
      this._suspenseList?.notifyBoundaryResolved(this);
    }
  }

  notifyListErrored() {
    if (this._lastListSnapshot === "errored") {
      return;
    }
    this._lastListSnapshot = "errored";
    this._suspenseList?.notifyBoundaryErrored(this);
  }

  attachToSuspenseList() {
    if (typeof this.closest !== "function") {
      return;
    }
    const list = this.closest("suspense-list");
    if (!list || typeof list.registerBoundary !== "function") {
      return;
    }
    this._suspenseList = list;
    list.registerBoundary(this);
  }

  detachFromSuspenseList() {
    if (!this._suspenseList || typeof this._suspenseList.unregisterBoundary !== "function") {
      this._suspenseList = null;
      return;
    }
    this._suspenseList.unregisterBoundary(this);
    this._suspenseList = null;
  }
}

const DOM_NODE = globalThis.Node ?? null;

function normalizeRevealOrder(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (
    normalized === "forwards" ||
    normalized === "backwards" ||
    normalized === "together"
  ) {
    return normalized;
  }
  return "together";
}

function normalizeTail(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (normalized === "collapsed" || normalized === "hidden") {
    return normalized;
  }
  return "collapsed";
}

function blocksReveal(boundary) {
  return (
    boundary != null &&
    (
      boundary.pending === true ||
      boundary.resolved !== true ||
      boundary.showing === "fallback" ||
      boundary.showing === "hidden"
    )
  );
}

/**
 * Coordinate reveal order across several sibling suspense boundaries.
 * SuspenseList controls when each boundary is allowed to reveal fallback or content.
 * Think of SuspenseList as the traffic controller for several sibling suspense regions.
 * @usage Wrap several SuspenseBoundary nodes when reveal order matters to the overall experience.
 * @usage Use revealOrder and tail to shape how pending sections appear while the list is still resolving.
 * @usage In custom-element markup, authored attributes should use kebab-case such as `reveal-order="forwards"` and `tail="collapsed"`.
 * @usage Use SuspenseList when several asynchronous sections belong to the same reading flow and should reveal in a predictable order.
 * @usage SuspenseList is a coordination primitive, not a visual wrapper. Use it to shape reveal timing without changing the authored styling model around the boundaries.
 * @behavior The list can delay fallback or content reveal so sibling boundaries appear in a stable order.
 * @behavior Reveal coordination happens in light DOM, so parent styles still flow naturally across the list.
 * @behavior `revealOrder="forwards"` favors top-to-bottom reveal, `revealOrder="backwards"` favors the opposite direction, and `revealOrder="together"` waits until every sibling is ready.
 * @behavior When authoring the custom element directly, use the reflected `reveal-order` attribute rather than camelCase HTML attributes.
 * @behavior `tail="collapsed"` keeps later pending regions out of the way without fully removing them, while `tail="hidden"` suppresses them until they can reveal.
 * @mentalModel SuspenseList does not fetch or render content by itself. It only decides when sibling boundaries are allowed to reveal fallback or content.
 * @pitfall Use SuspenseList for groups of boundaries that belong to the same reading or interaction flow. Unrelated sections usually read better when they reveal independently.
 * @pitfall Do not rely on SuspenseList for layout. Its job is reveal coordination, not visual composition.
 * @example
 * <SuspenseList revealOrder="forwards">
 *   <SuspenseBoundary fallback={<span>Loading first...</span>}>
 *     <FirstPanel />
 *   </SuspenseBoundary>
 *   <SuspenseBoundary fallback={<span>Loading second...</span>}>
 *     <SecondPanel />
 *   </SuspenseBoundary>
 * </SuspenseList>
 *
 * @example
 * <suspense-list reveal-order="forwards" tail="collapsed">
 *   <suspense-boundary></suspense-boundary>
 * </suspense-list>
 */
class SuspenseList extends LightDomMixin(y) {
  static [Symbol.for("litsx.component")] = true;

  static properties = {
    revealOrder: { type: String, attribute: "reveal-order" },
    tail: { type: String },
  };

  constructor() {
    super();
    this._revealOrder = "together";
    this._tail = "collapsed";
    this._boundaries = [];
    this._refreshQueued = false;
  }

  get revealOrder() {
    return this._revealOrder;
  }

  set revealOrder(value) {
    const nextValue = normalizeRevealOrder(value);
    const previousValue = this._revealOrder;
    if (previousValue === nextValue) {
      return;
    }
    this._revealOrder = nextValue;
    this.requestUpdate("revealOrder", previousValue);
  }

  get tail() {
    return this._tail;
  }

  set tail(value) {
    const nextValue = normalizeTail(value);
    const previousValue = this._tail;
    if (previousValue === nextValue) {
      return;
    }
    this._tail = nextValue;
    this.requestUpdate("tail", previousValue);
  }

  registerBoundary(boundary) {
    if (!boundary || this._boundaries.includes(boundary)) {
      return;
    }
    this._boundaries.push(boundary);
    this.sortBoundaries();
    this.scheduleBoundaryRefresh();
  }

  unregisterBoundary(boundary) {
    const index = this._boundaries.indexOf(boundary);
    if (index === -1) {
      return;
    }
    this._boundaries.splice(index, 1);
    this.scheduleBoundaryRefresh();
  }

  notifyBoundaryPending(_boundary) {
    this.scheduleBoundaryRefresh();
  }

  notifyBoundaryResolved(_boundary) {
    this.scheduleBoundaryRefresh();
  }

  notifyBoundaryErrored(_boundary) {
    this.scheduleBoundaryRefresh();
  }

  getFallbackDisposition(boundary) {
    const boundaries = this.getOrderedBoundaries();
    const index = boundaries.indexOf(boundary);
    if (index === -1) {
      return "show";
    }

    if (this.revealOrder === "backwards") {
      const blocked = boundaries.slice(index + 1).some((entry) => entry.pending);
      if (!blocked) {
        return "show";
      }
      return this.tail === "hidden" ? "hidden" : "collapsed";
    }

    if (this.revealOrder === "together") {
      return "show";
    }

    const blocked = boundaries.slice(0, index).some((entry) => entry.pending);
    if (!blocked) {
      return "show";
    }

    return this.tail === "hidden" ? "hidden" : "collapsed";
  }

  getContentDisposition(boundary) {
    const boundaries = this.getOrderedBoundaries();
    const index = boundaries.indexOf(boundary);
    if (index === -1) {
      return "content";
    }

    if (this.revealOrder === "backwards") {
      const blocked = boundaries
        .slice(index + 1)
        .some((entry) => entry !== boundary && blocksReveal(entry));
      return blocked ? "fallback" : "content";
    }

    if (this.revealOrder === "forwards") {
      const blocked = boundaries
        .slice(0, index)
        .some((entry) => entry !== boundary && blocksReveal(entry));
      return blocked ? "fallback" : "content";
    }

    const blocked = boundaries.some(
      (entry) => entry !== boundary && blocksReveal(entry)
    );

    return blocked ? "fallback" : "content";
  }

  shouldShowFallback(boundary) {
    return this.getFallbackDisposition(boundary) === "show";
  }

  getOrderedBoundaries() {
    this.sortBoundaries();
    return this._boundaries.slice();
  }

  sortBoundaries() {
    this._boundaries.sort((left, right) => {
      if (left === right) {
        return 0;
      }

      if (typeof left.compareDocumentPosition !== "function") {
        return 0;
      }

      const relation = left.compareDocumentPosition(right);
      if (DOM_NODE && relation & DOM_NODE.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (DOM_NODE && relation & DOM_NODE.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });
  }

  requestBoundaryRefresh() {
    for (const boundary of this._boundaries) {
      if (typeof boundary?.requestUpdate === "function") {
        boundary.requestUpdate();
      }
    }
  }

  scheduleBoundaryRefresh() {
    if (this._refreshQueued) {
      return;
    }

    this._refreshQueued = true;
    queueMicrotask(() => {
      this._refreshQueued = false;
      this.requestBoundaryRefresh();
    });
  }

  update(changedProperties) {
    super.update(changedProperties);

    // Keep the authored light-DOM children untouched. This element acts as a
    // coordinator/wrapper and only mirrors configuration through attributes.
    this.setAttribute("reveal-order", this.revealOrder);
    this.setAttribute("tail", this.tail);

    if (
      changedProperties.has("revealOrder") ||
      changedProperties.has("tail")
    ) {
      this.scheduleBoundaryRefresh();
    }
  }
}

function normalizeDeps(deps) {
  if (Array.isArray(deps)) {
    return deps.slice();
  }
  return deps ?? undefined;
}

function haveDepsChanged(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) {
    return true;
  }
  if (prev.length !== next.length) {
    return true;
  }
  for (let index = 0; index < prev.length; index += 1) {
    if (!Object.is(prev[index], next[index])) {
      return true;
    }
  }
  return false;
}

function shouldRerunRecord(record, nextDeps) {
  if (nextDeps === null) {
    return true;
  }
  if (!record.hasRun || !Array.isArray(record.deps)) {
    return true;
  }
  return haveDepsChanged(record.deps, nextDeps);
}

function assignRef(ref, value) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (typeof ref === "object") {
    ref.current = value;
  }
}

function cleanupRef(ref) {
  assignRef(ref, null);
}

const Priority = {
  IMMEDIATE: 0,
  TRANSITION: 1,
  IDLE: 2,
};

class PriorityScheduler {
  constructor(host) {
    this.host = host;
    this.queues = {
      [Priority.IMMEDIATE]: [],
      [Priority.TRANSITION]: [],
      [Priority.IDLE]: [],
    };
    this.flushScheduled = false;
  }

  enqueue(task) {
    const bucket = this.queues[task.priority ?? Priority.IDLE];
    bucket.push(task);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush() {
    if (!this.flushScheduled) return;
    this.flushScheduled = false;

    for (const priority of [Priority.IMMEDIATE, Priority.TRANSITION, Priority.IDLE]) {
      const bucket = this.queues[priority];
      if (!bucket.length) continue;
      while (bucket.length) {
        const task = bucket.shift();
        try {
          task.flush();
        } catch (error) {
          this.host?.reportError?.(error);
          throw error;
        }
      }
    }
  }

  resetFrame() {
    // Called at the start of render; nothing frame-specific yet but keeps API symmetry.
  }

  clear() {
    for (const priority of Object.keys(this.queues)) {
      this.queues[priority].length = 0;
    }
    this.flushScheduled = false;
  }
}

const HOST_ADOPTED_CONTROLLERS = Symbol("litsx.adoptedControllers");
const HOST_ADOPTED_WRAPPED = Symbol("litsx.adoptedWrapped");

function ensureAdoptedControllerHook(host) {
  if (!host || typeof host !== "object") {
    return;
  }

  if (!host[HOST_ADOPTED_CONTROLLERS]) {
    host[HOST_ADOPTED_CONTROLLERS] = new Set();
  }

  if (host[HOST_ADOPTED_WRAPPED]) {
    return;
  }

  const originalAdoptedCallback = host.adoptedCallback;

  host.adoptedCallback = function adoptedCallback(...args) {
    if (typeof originalAdoptedCallback === "function") {
      originalAdoptedCallback.apply(this, args);
    }

    const controllers = this[HOST_ADOPTED_CONTROLLERS];
    if (!controllers) {
      return;
    }

    for (const controller of controllers) {
      if (controller && typeof controller.hostAdopted === "function") {
        controller.hostAdopted(...args);
      }
    }
  };

  host[HOST_ADOPTED_WRAPPED] = true;
}

function addAdoptedController(host, controller) {
  ensureAdoptedControllerHook(host);
  host[HOST_ADOPTED_CONTROLLERS].add(controller);
}

function isThenable(value) {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function createTransitionState(controller) {
  const state = {
    controller,
    isPending: false,
    pendingCount: 0,
    pendingTokens: new Set(),
    lastToken: 0,
    startTransition: null,
  };

  state.startTransition = (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("startTransition expects a function");
    }

    const token = ++state.lastToken;
    state.pendingTokens.add(token);
    state.pendingCount = state.pendingTokens.size;
    state.isPending = true;
    controller.host?.requestUpdate?.();

    let finalized = false;
    const finish = () => {
      if (finalized) return;
      finalized = true;
      if (!state.pendingTokens.delete(token)) {
        return;
      }
      state.pendingCount = state.pendingTokens.size;
      if (state.pendingCount === 0) {
        state.isPending = false;
        controller.host?.requestUpdate?.();
      }
    };

    let result;
    try {
      result = callback();
    } catch (error) {
      finish();
      throw error;
    }

    if (isThenable(result)) {
      Promise.resolve(result).then(finish, finish);
    } else {
      queueMicrotask(finish);
    }

    return result;
  };

  return state;
}

function resetTransitionState(state) {
  if (!state) return;
  state.isPending = false;
  state.pendingCount = 0;
  state.pendingTokens?.clear();
}

function shouldUseServerSnapshot() {
  return typeof window === "undefined";
}

function readExternalSnapshot(slot) {
  const { getSnapshot, getServerSnapshot } = slot;
  const getter = shouldUseServerSnapshot() && typeof getServerSnapshot === "function"
    ? getServerSnapshot
    : getSnapshot;
  return getter();
}

function cleanupExternalStoreSlot(slot) {
  if (!slot?.unsubscribe) {
    return;
  }

  try {
    slot.unsubscribe();
  } finally {
    slot.unsubscribe = null;
  }
}

function createExternalStoreEffect(slot, host) {
  return () => {
    cleanupExternalStoreSlot(slot);

    const latestSnapshot = readExternalSnapshot(slot);
    if (!Object.is(slot.value, latestSnapshot)) {
      slot.value = latestSnapshot;
      host.requestUpdate?.();
    }

    const unsubscribe = slot.subscribe(() => {
      const nextValue = readExternalSnapshot(slot);
      if (!Object.is(slot.value, nextValue)) {
        slot.value = nextValue;
        host.requestUpdate?.();
      }
    });

    slot.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;

    return () => {
      cleanupExternalStoreSlot(slot);
    };
  };
}

function runCleanup(record, host) {
  if (typeof record?.cleanup !== "function") {
    return;
  }

  try {
    record.cleanup.call(host);
  } finally {
    record.cleanup = undefined;
  }
}

function registerEffect(controller, callback, deps, layout) {
  const index = controller.cursor;
  const nextDeps = Array.isArray(deps) ? deps.slice() : null;
  let record = controller.effects[index];

  if (!record) {
    record = controller.effects[index] = {
      callback,
      deps: nextDeps,
      cleanup: undefined,
      hasRun: false,
      layout,
      needsRun: true,
    };
  } else {
    const prevDeps = record.deps;
    const prevHasRun = record.hasRun;
    record.callback = callback;
    record.layout = layout;
    record.needsRun = shouldRerunRecord(
      { deps: prevDeps, hasRun: prevHasRun },
      nextDeps
    );
    record.deps = nextDeps;
    if (record.needsRun) {
      record.hasRun = false;
    }
  }

  controller.cursor = index + 1;
  return index;
}

function registerConnectedEffect(controller, callback, deps) {
  const index = controller.connectedCursor;
  const nextDeps = Array.isArray(deps) ? deps.slice() : [];
  let record = controller.connectedEffects[index];

  if (!record) {
    record = controller.connectedEffects[index] = {
      callback,
      deps: nextDeps,
      cleanup: undefined,
      active: false,
      needsRun: true,
    };
  } else {
    const prevDeps = record.deps;
    record.callback = callback;
    record.needsRun = !record.active || haveDepsChanged(prevDeps, nextDeps);
    record.deps = nextDeps;
  }

  controller.connectedCursor = index + 1;
  return index;
}

function buildEffectQueues(controller) {
  const count = Math.min(controller.effects.length, controller.cursor);
  const layoutQueue = [];
  const passiveQueue = [];

  for (let index = 0; index < count; index += 1) {
    const record = controller.effects[index];
    if (!record) continue;
    const shouldRun = record.needsRun || !record.hasRun || record.deps === null;
    if (!shouldRun) continue;
    (record.layout ? layoutQueue : passiveQueue).push(record);
  }

  if (controller.effects.length > count) {
    for (let index = count; index < controller.effects.length; index += 1) {
      runCleanup(controller.effects[index], controller.host);
    }
    controller.effects.length = count;
  }

  controller.layoutQueue = layoutQueue;
  controller.passiveQueue = passiveQueue;
  controller.cursor = 0;
}

function finalizeConnectedEffects(controller) {
  const count = Math.min(
    controller.connectedEffects.length,
    controller.connectedCursor
  );

  if (controller.connectedEffects.length > count) {
    for (let index = count; index < controller.connectedEffects.length; index += 1) {
      const record = controller.connectedEffects[index];
      if (record?.active) {
        runCleanup(record, controller.host);
      }
    }
    controller.connectedEffects.length = count;
  }

  controller.connectedCursor = 0;
}

function runEffectQueue(controller, queue) {
  for (const record of queue) {
    runCleanup(record, controller.host);
    const cleanup = record.callback.call(controller.host);
    record.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    record.hasRun = true;
    record.needsRun = false;
  }
}

function runConnectedEffects(controller, force = false) {
  for (const record of controller.connectedEffects) {
    if (!record) continue;
    const shouldRun = force || record.needsRun || !record.active;
    if (!shouldRun) continue;

    runCleanup(record, controller.host);

    const cleanup = record.callback.call(controller.host);
    record.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    record.active = true;
    record.needsRun = false;
  }
}

function cleanupDisconnectedEffects(controller) {
  for (const record of controller.effects) {
    runCleanup(record, controller.host);
    if (record) record.hasRun = false;
  }

  for (const record of controller.connectedEffects) {
    if (record?.active) {
      runCleanup(record, controller.host);
    }
    if (record) {
      record.active = false;
      record.needsRun = true;
    }
  }
}

function resetAdoptedConnectedEffects(controller) {
  for (const record of controller.connectedEffects) {
    if (record?.active) {
      runCleanup(record, controller.host);
    }
    if (record) {
      record.active = false;
      record.needsRun = true;
    }
  }
}

function resolveDeferredValue(controller, value, options) {
  const index = controller.deferredCursor || 0;
  controller.deferredCursor = index + 1;
  let slot = controller.deferredValues[index];

  if (!slot) {
    slot = controller.deferredValues[index] = {
      source: value,
      current: value,
      pending: false,
      timer: null,
      version: 0,
      options: null,
    };
    return slot;
  }

  const hasChanged = !Object.is(slot.source, value);
  slot.options = options || null;

  if (hasChanged) {
    slot.source = value;
    slot.version += 1;
    scheduleDeferredFlush(controller, slot);
  }

  return slot;
}

function scheduleDeferredFlush(controller, slot) {
  if (slot.timer != null) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }

  const timeout =
    slot.options && typeof slot.options.timeout === "number"
      ? Math.max(0, slot.options.timeout)
      : 0;

  const token = slot.version;
  slot.pending = true;

  slot.timer = setTimeout(() => {
    slot.timer = null;
    if (slot.version !== token) {
      return;
    }
    slot.current = slot.source;
    slot.pending = false;
    controller.priorityQueue.enqueue({
      priority: Priority.TRANSITION,
      flush: () => controller.host?.requestUpdate?.(),
    });
  }, timeout);
}

function clearDeferredValues(controller) {
  if (!controller.deferredValues?.length) return;
  for (const slot of controller.deferredValues) {
    if (!slot) continue;
    if (slot.timer != null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    slot.pending = false;
  }
}

let globalIdCounter = 0;

function createStableId() {
  globalIdCounter += 1;
  return `litsx-${globalIdCounter}`;
}

function resolveMemo(controller, factory, deps) {
  const index = controller.memoCursor;
  const normalized = normalizeDeps(deps);
  let slot = controller.memos[index];

  if (!slot) {
    slot = controller.memos[index] = {
      deps: normalized,
      value: factory(),
    };
  } else {
    const shouldCompare = Array.isArray(normalized);
    const depsChanged = shouldCompare ? haveDepsChanged(slot.deps, normalized) : true;
    if (depsChanged) {
      slot.value = factory();
    }
    slot.deps = normalized;
  }

  controller.memoCursor = index + 1;
  return slot.value;
}

function resolveCallback(controller, callback, deps) {
  const index = controller.callbackCursor;
  const normalized = normalizeDeps(deps);
  let slot = controller.callbacks[index];

  if (!slot) {
    slot = controller.callbacks[index] = {
      deps: normalized,
      value: callback,
    };
  } else {
    const shouldCompare = Array.isArray(normalized);
    const depsChanged = shouldCompare ? haveDepsChanged(slot.deps, normalized) : true;
    if (depsChanged) {
      slot.value = callback;
    }
    slot.deps = normalized;
  }

  controller.callbackCursor = index + 1;
  return slot.value;
}

function resolveEvent(controller, callback) {
  const index = controller.eventCursor;
  let slot = controller.events[index];

  if (!slot) {
    slot = controller.events[index] = {
      callback,
      value: function stableEventCallback(...args) {
        return slot.callback.apply(this, args);
      },
    };
  } else {
    slot.callback = callback;
  }

  controller.eventCursor = index + 1;
  return slot.value;
}

function resolvePrevious(controller, value, initialValue) {
  const index = controller.previousCursor;
  let slot = controller.previousValues[index];

  if (!slot) {
    slot = controller.previousValues[index] = { value };
    controller.previousCursor = index + 1;
    return initialValue;
  }

  const previousValue = slot.value;
  slot.value = value;
  controller.previousCursor = index + 1;
  return previousValue;
}

function resolveReducer(controller, reducer, initialArg, init) {
  const index = controller.reducerCursor;
  let slot = controller.reducers[index];

  if (!slot) {
    const initialState = typeof init === "function" ? init(initialArg) : initialArg;

    slot = {
      state: initialState,
      reducer,
      dispatch: null,
    };

    slot.dispatch = (action) => {
      const prevState = slot.state;
      const nextState = slot.reducer(slot.state, action);
      if (!Object.is(prevState, nextState)) {
        slot.state = nextState;
        controller.host.requestUpdate?.();
      }
      return slot.state;
    };

    controller.reducers[index] = slot;
  }

  slot.reducer = reducer;
  controller.reducerCursor = index + 1;
  return [slot.state, slot.dispatch];
}

function resolveMutableRef(controller, initialValue) {
  const index = controller.mutableRefCursor;
  let slot = controller.mutableRefs[index];

  if (!slot) {
    slot = controller.mutableRefs[index] = {
      ref: { current: initialValue },
    };
  }

  controller.mutableRefCursor = index + 1;
  return slot.ref;
}

function resolveId(controller) {
  const index = controller.idCursor;
  let slot = controller.ids[index];

  if (!slot) {
    slot = controller.ids[index] = {
      value: createStableId(),
    };
  }

  controller.idCursor = index + 1;
  return slot.value;
}

const EXPOSED_METHODS = Symbol.for("litsx.exposedMethods");

function isObject$2(value) {
  return value !== null && typeof value === "object";
}

function getExposedMethodRegistry(host) {
  if (!isObject$2(host)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(host, EXPOSED_METHODS)) {
    Object.defineProperty(host, EXPOSED_METHODS, {
      value: new Map(),
      configurable: true,
    });
  }
  return host[EXPOSED_METHODS];
}

function resolveLatestExposeImplementation(owners) {
  let activeOwner = -1;
  let activeImplementation = null;

  for (const [owner, implementation] of owners) {
    if (owner >= activeOwner) {
      activeOwner = owner;
      activeImplementation = implementation;
    }
  }

  return activeImplementation;
}

function removeExposedMethod(host, slotIndex, methodName) {
  const registry = getExposedMethodRegistry(host);
  const entry = registry?.get(methodName);
  if (!entry) {
    return;
  }

  entry.owners.delete(slotIndex);
  entry.implementation = resolveLatestExposeImplementation(entry.owners);

  if (typeof entry.implementation === "function") {
    return;
  }

  delete host[methodName];
  registry.delete(methodName);
}

function installExposedMethods(host, slotIndex, slot, handle) {
  if (!isObject$2(handle)) {
    throw new TypeError("useExpose expects createHandle() to return an object of imperative methods.");
  }

  const registry = getExposedMethodRegistry(host);
  if (!registry) {
    return;
  }

  const methodNames = Object.keys(handle);
  for (const name of methodNames) {
    if (typeof handle[name] !== "function") {
      throw new TypeError(`useExpose only supports imperative methods. Received non-function member "${name}".`);
    }
  }

  for (const existingName of slot.methodNames || []) {
    if (!methodNames.includes(existingName)) {
      removeExposedMethod(host, slotIndex, existingName);
    }
  }

  for (const name of methodNames) {
    const implementation = handle[name];
    let entry = registry.get(name);
    let wrapper = entry?.wrapper;

    if (!wrapper) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(host, name);
      if (ownDescriptor && !entry) {
        throw new TypeError(`useExpose cannot install method "${name}" because the host already defines that own property.`);
      }

      wrapper = function exposedHostMethod(...args) {
        const currentEntry = registry.get(name);
        const currentImplementation = currentEntry?.implementation;
        if (typeof currentImplementation !== "function") {
          return undefined;
        }
        return currentImplementation.apply(host, args);
      };

      Object.defineProperty(host, name, {
        value: wrapper,
        writable: true,
        configurable: true,
      });

      entry = {
        wrapper,
        owners: new Map(),
        implementation: null,
      };
      registry.set(name, entry);
    }

    entry.owners.set(slotIndex, implementation);
    entry.implementation = resolveLatestExposeImplementation(entry.owners);
  }

  slot.methodNames = methodNames;
}

function cleanupExposedSlot(host, slotIndex, slot) {
  for (const methodName of slot?.methodNames || []) {
    removeExposedMethod(host, slotIndex, methodName);
  }
  if (slot) {
    slot.methodNames = [];
  }
}

function getExposeRefTarget(controller, ref) {
  if (!controller.exposeRefTargets.has(ref)) {
    controller.exposeRefTargets.set(ref, {
      methods: new Map(),
      handle: {},
    });
  }
  return controller.exposeRefTargets.get(ref);
}

function removeExposedRefMethod(controller, slotIndex, slot, methodName) {
  const target = controller.exposeRefTargets.get(slot?.ref);
  const entry = target?.methods.get(methodName);
  if (!entry) {
    return;
  }

  entry.owners.delete(slotIndex);
  entry.implementation = resolveLatestExposeImplementation(entry.owners);

  if (typeof entry.implementation !== "function") {
    target.methods.delete(methodName);
    delete target.handle[methodName];
  }

  if (target.methods.size === 0) {
    cleanupRef(slot.ref);
    controller.exposeRefTargets.delete(slot.ref);
  } else {
    assignRef(slot.ref, target.handle);
  }
}

function cleanupExposedRefSlot(controller, slotIndex, slot) {
  if (!slot?.ref) {
    slot.methodNames = [];
    slot.ref = null;
    return;
  }

  for (const methodName of slot.methodNames || []) {
    removeExposedRefMethod(controller, slotIndex, slot, methodName);
  }

  slot.methodNames = [];
  slot.ref = null;
}

function installExposedRefMethods(controller, slotIndex, slot, ref, handle) {
  if (!isObject$2(handle)) {
    throw new TypeError("useExpose expects createHandle() to return an object of imperative methods.");
  }

  const methodNames = Object.keys(handle);
  for (const name of methodNames) {
    if (typeof handle[name] !== "function") {
      throw new TypeError(`useExpose only supports imperative methods. Received non-function member "${name}".`);
    }
  }

  if (slot.ref && slot.ref !== ref) {
    cleanupExposedRefSlot(controller, slotIndex, slot);
  }

  slot.ref = ref;
  const target = getExposeRefTarget(controller, ref);

  for (const existingName of slot.methodNames || []) {
    if (!methodNames.includes(existingName)) {
      removeExposedRefMethod(controller, slotIndex, slot, existingName);
    }
  }

  for (const name of methodNames) {
    let entry = target.methods.get(name);

    if (typeof target.handle[name] !== "function") {
      target.handle[name] = function exposedRefMethod(...args) {
        const currentImplementation = target.methods.get(name)?.implementation;
        if (typeof currentImplementation !== "function") {
          return undefined;
        }
        return currentImplementation.apply(this, args);
      };

      entry = {
        owners: new Map(),
        implementation: null,
      };
      target.methods.set(name, entry);
    } else if (!entry) {
      entry = {
        owners: new Map(),
        implementation: null,
      };
      target.methods.set(name, entry);
    }

    entry.owners.set(slotIndex, handle[name]);
    entry.implementation = resolveLatestExposeImplementation(entry.owners);
  }

  slot.methodNames = methodNames;
  assignRef(ref, target.handle);
}

/**
 * @internal
 */
class EffectsController {
  constructor(host) {
    this.host = host;
    this.effects = [];
    this.cursor = 0;
    this.connectedEffects = [];
    this.connectedCursor = 0;
    this.hostIsConnected = Boolean(host?.isConnected);

    this.memos = [];
    this.memoCursor = 0;

    this.callbacks = [];
    this.callbackCursor = 0;
    this.events = [];
    this.eventCursor = 0;
    this.previousValues = [];
    this.previousCursor = 0;

    this.reducers = [];
    this.reducerCursor = 0;

    this.mutableRefs = [];
    this.mutableRefCursor = 0;

    this.ids = [];
    this.idCursor = 0;

    this.imperatives = [];
    this.imperativeCursor = 0;
    this.exposeSlots = [];
    this.exposeCursor = 0;
    this.prevExposeCount = 0;
    this.exposeRefSlots = [];
    this.exposeRefCursor = 0;
    this.prevExposeRefCount = 0;
    this.exposeRefTargets = new Map();

    this.externalStores = [];
    this.externalStoreCursor = 0;
    this.prevExternalStoreCount = 0;

    this.transitionState = createTransitionState(this);
    this.pendingSuspenseSlots = new Set();
    this.deferredValues = [];
    this.deferredCursor = 0;
    this.priorityQueue = new PriorityScheduler(host);

    this.layoutQueue = null;
    this.passiveQueue = null;
    this.passiveScheduled = false;

    addAdoptedController(host, this);
    host.addController(this);
  }

  prepare() {
    this.cursor = 0;
    this.connectedCursor = 0;
    this.memoCursor = 0;
    this.callbackCursor = 0;
    this.eventCursor = 0;
    this.previousCursor = 0;
    this.reducerCursor = 0;
    this.mutableRefCursor = 0;
    this.idCursor = 0;
    this.imperativeCursor = 0;
    this.prevExposeCount = this.exposeCursor;
    this.exposeCursor = 0;
    this.prevExposeRefCount = this.exposeRefCursor;
    this.exposeRefCursor = 0;
    this.prevExternalStoreCount = this.externalStoreCursor;
    this.externalStoreCursor = 0;
    this.deferredCursor = 0;
    this.priorityQueue.resetFrame();
  }

  register(callback, deps, layout) {
    return registerEffect(this, callback, deps, layout);
  }

  registerConnected(callback, deps) {
    return registerConnectedEffect(this, callback, deps);
  }

  buildQueues() {
    buildEffectQueues(this);
  }

  finalizeConnectedEffects() {
    finalizeConnectedEffects(this);
  }

  runQueue(queue) {
    runEffectQueue(this, queue);
  }

  runLayoutNow() {
    if (this.layoutQueue?.length) {
      this.runQueue(this.layoutQueue);
      this.layoutQueue = null;
    }
  }

  schedulePassive() {
    if (this.passiveScheduled || !this.passiveQueue?.length) return;
    this.passiveScheduled = true;
    requestAnimationFrame(() => {
      try {
        if (this.passiveQueue?.length) this.runQueue(this.passiveQueue);
      } finally {
        this.passiveQueue = null;
        this.passiveScheduled = false;
      }
    });
  }

  runConnectedEffects(force = false) {
    runConnectedEffects(this, force);
  }

  hostUpdate() {}

  hostUpdated() {
    this.buildQueues();
    this.finalizeConnectedEffects();
    this.runLayoutNow();
    this.schedulePassive();
    if (this.hostIsConnected) {
      this.runConnectedEffects();
    }
    this.cleanupUnusedExposedSlots();
    this.cleanupUnusedExposedRefSlots();
    this.cleanupUnusedExternalStores();
    this.resolvePendingTransitions();
    this.flushSuspenseQueues();
    this.priorityQueue.flush();
  }

  hostConnected() {
    this.hostIsConnected = true;
    this.runConnectedEffects();
  }

  hostDisconnected() {
    this.hostIsConnected = false;
    cleanupDisconnectedEffects(this);

    this.layoutQueue = null;
    this.passiveQueue = null;
    this.passiveScheduled = false;

    resetTransitionState(this.transitionState);

    this.pendingSuspenseSlots.clear();
    for (const imperative of this.imperatives) {
      if (!imperative) continue;
      cleanupRef(imperative.ref);
    }

    for (let index = 0; index < this.exposeRefSlots.length; index += 1) {
      cleanupExposedRefSlot(this, index, this.exposeRefSlots[index]);
    }
    this.exposeRefSlots.length = 0;
    this.exposeRefCursor = 0;
    this.prevExposeRefCount = 0;
    this.exposeRefTargets.clear();

    for (const store of this.externalStores) {
      cleanupExternalStoreSlot(store);
    }
    this.externalStores.length = 0;
    this.externalStoreCursor = 0;
    this.prevExternalStoreCount = 0;
    clearDeferredValues(this);
    this.priorityQueue.clear();
  }

  hostAdopted() {
    if (!this.hostIsConnected) {
      return;
    }

    resetAdoptedConnectedEffects(this);
    this.runConnectedEffects(true);
  }

  resolveMemo(factory, deps) {
    return resolveMemo(this, factory, deps);
  }

  resolveCallback(callback, deps) {
    return resolveCallback(this, callback, deps);
  }

  resolveEvent(callback) {
    return resolveEvent(this, callback);
  }

  resolvePrevious(value, initialValue) {
    return resolvePrevious(this, value, initialValue);
  }

  resolveTransition() {
    const state = this.transitionState ||= createTransitionState(this);
    return [state.isPending, state.startTransition];
  }

  startTransition(callback) {
    const state = this.transitionState ||= createTransitionState(this);
    return state.startTransition(callback);
  }

  registerSuspenseSlot(slot) {
    this.pendingSuspenseSlots.add(slot);
  }

  flushSuspenseQueues() {
    if (!this.pendingSuspenseSlots.size) return;
    for (const slot of this.pendingSuspenseSlots) {
      if (slot && typeof slot.flush === "function") {
        slot.flush(this);
      }
    }
    this.pendingSuspenseSlots.clear();
  }

  resolveReducer(reducer, initialArg, init) {
    return resolveReducer(this, reducer, initialArg, init);
  }

  resolveMutableRef(initialValue) {
    return resolveMutableRef(this, initialValue);
  }

  resolveId() {
    return resolveId(this);
  }

  registerImperative(ref, createHandle, deps) {
    const index = this.imperativeCursor;
    const normalized = normalizeDeps(deps);

    const callback = () => {
      const handle = typeof createHandle === "function" ? createHandle() : createHandle;
      assignRef(ref, handle);
      return () => {
        cleanupRef(ref);
      };
    };

    this.register(callback, normalized, true);
    this.imperatives[index] = { ref };
    this.imperativeCursor = index + 1;
  }

  registerExpose(createHandle, deps) {
    const index = this.exposeCursor;
    const slot = this.exposeSlots[index] ||= { methodNames: [] };
    const normalized = normalizeDeps(deps);

    const callback = () => {
      const handle = typeof createHandle === "function" ? createHandle() : createHandle;
      installExposedMethods(this.host, index, slot, handle);
    };

    this.register(callback, normalized, true);
    this.exposeCursor = index + 1;
  }

  registerExposeRef(ref, createHandle, deps) {
    const index = this.exposeRefCursor;
    const slot = this.exposeRefSlots[index] ||= { ref: null, methodNames: [] };
    const normalized = normalizeDeps(deps);

    const callback = () => {
      const handle = typeof createHandle === "function" ? createHandle() : createHandle;
      installExposedRefMethods(this, index, slot, ref, handle);
    };

    this.register(callback, normalized, true);
    this.exposeRefCursor = index + 1;
  }

  cleanupUnusedExposedSlots() {
    if (this.prevExposeCount <= this.exposeCursor) {
      this.prevExposeCount = this.exposeCursor;
      return;
    }

    for (let index = this.exposeCursor; index < this.prevExposeCount; index += 1) {
      cleanupExposedSlot(this.host, index, this.exposeSlots[index]);
    }

    this.exposeSlots.length = this.exposeCursor;
    this.prevExposeCount = this.exposeCursor;
  }

  cleanupUnusedExposedRefSlots() {
    if (this.prevExposeRefCount <= this.exposeRefCursor) {
      this.prevExposeRefCount = this.exposeRefCursor;
      return;
    }

    for (let index = this.exposeRefCursor; index < this.prevExposeRefCount; index += 1) {
      cleanupExposedRefSlot(this, index, this.exposeRefSlots[index]);
    }

    this.exposeRefSlots.length = this.exposeRefCursor;
    this.prevExposeRefCount = this.exposeRefCursor;
  }

  resolvePendingTransitions() {
    const state = this.transitionState;
    if (!state) return;
    if (state.pendingCount <= 0 && state.isPending) {
      state.pendingCount = 0;
      state.isPending = false;
    }
  }

  resolveExternalStore(subscribe, getSnapshot, getServerSnapshot) {
    const index = this.externalStoreCursor;
    let slot = this.externalStores[index];

    if (!slot) {
      slot = this.externalStores[index] = {
        subscribe,
        getSnapshot,
        getServerSnapshot: typeof getServerSnapshot === "function" ? getServerSnapshot : null,
        unsubscribe: null,
        value: undefined,
      };
    } else {
      slot.subscribe = subscribe;
      slot.getSnapshot = getSnapshot;
      slot.getServerSnapshot = typeof getServerSnapshot === "function" ? getServerSnapshot : null;
    }

    slot.value = readExternalSnapshot(slot);

    const deps = [subscribe, getSnapshot];
    if (slot.getServerSnapshot) {
      deps.push(slot.getServerSnapshot);
    }

    const effect = createExternalStoreEffect(slot, this.host);

    this.register(effect, deps, true);

    this.externalStoreCursor = index + 1;
    return slot.value;
  }

  cleanupUnusedExternalStores() {
    if (this.prevExternalStoreCount <= this.externalStoreCursor) {
      this.prevExternalStoreCount = this.externalStoreCursor;
      return;
    }

    for (let index = this.externalStoreCursor; index < this.prevExternalStoreCount; index += 1) {
      const slot = this.externalStores[index];
      cleanupExternalStoreSlot(slot);
    }

    this.externalStores.length = this.externalStoreCursor;
    this.prevExternalStoreCount = this.externalStoreCursor;
  }

  resolveDeferredValue(value, options) {
    return resolveDeferredValue(this, value, options);
  }

  scheduleDeferredFlush(slot) {
    scheduleDeferredFlush(this, slot);
  }

  clearDeferredValues() {
    clearDeferredValues(this);
  }
}

const EXECUTION_CONTEXT_KEY_DESCRIPTION = Symbol("litsx.executionContextKey.description");

function createExecutionContextKey(description) {
  const key = {};

  if (description !== undefined) {
    Object.defineProperty(key, EXECUTION_CONTEXT_KEY_DESCRIPTION, {
      value: String(description),
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }

  return Object.freeze(key);
}

function getCurrentExecutionContext() {
  return getCurrentExecutionContextInternal();
}

const LITSX_HOOK = Symbol.for("litsx.hook");

function isLitsxHook(value) {
  return typeof value === "function" && value[LITSX_HOOK] === true;
}

const EMPTY_ARGS = Object.freeze([]);
const STRUCTURAL_HOOK_DEFINITION = Symbol.for("litsx.structuralHookDefinition");
const STRUCTURAL_HOOK_ENTRIES = Symbol.for("litsx.structuralHookEntries");
const STRUCTURAL_STATIC_STATE = Symbol.for("litsx.structuralStaticState");
const STRUCTURAL_HOST_ACCESSORS = Symbol.for("litsx.structuralHostAccessors");
const STRUCTURAL_HOST_PROPS = Symbol.for("litsx.structuralHostProps");
const LIFECYCLE_METHODS = [
  "connectedCallback",
  "disconnectedCallback",
  "attributeChangedCallback",
  "formAssociatedCallback",
  "formDisabledCallback",
  "formResetCallback",
  "formStateRestoreCallback",
  "scheduleUpdate",
  "shouldUpdate",
  "willUpdate",
  "update",
  "updated",
  "firstUpdated",
  "getUpdateComplete",
];

function isObject$1(value) {
  return value !== null && typeof value === "object";
}

function resolveStructuralDefinition(definition) {
  return typeof definition === "function" && definition[STRUCTURAL_HOOK_DEFINITION]
    ? definition[STRUCTURAL_HOOK_DEFINITION]
    : definition;
}

function createStructuralHookCallable() {
  return function structuralHookMustBeCompiled() {
    throw new Error(
      "Structural hooks created with defineHook() must be compiled by LitSX before they can be called."
    );
  };
}

function defineHook(definition) {
  const hook = createStructuralHookCallable();
  Object.defineProperty(hook, STRUCTURAL_HOOK_DEFINITION, {
    value: definition,
    configurable: true,
  });
  return hook;
}

function isStructuralHook(value) {
  return typeof value === "function" && Boolean(value[STRUCTURAL_HOOK_DEFINITION]);
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args : EMPTY_ARGS;
}

function normalizeInvocation(argsOrBase, maybeBase) {
  if (typeof argsOrBase === "function" && maybeBase == null) {
    return {
      args: EMPTY_ARGS,
      base: argsOrBase,
    };
  }

  return {
    args: normalizeArgs(argsOrBase),
    base: typeof maybeBase === "function" ? maybeBase : () => undefined,
  };
}

function normalizeHookPath(path) {
  return Array.isArray(path)
    ? path.map((part) => String(part))
    : [];
}

function getStructuralEntryId(callsiteId, callsiteIndex) {
  return typeof callsiteId === "string" && callsiteId
    ? callsiteId
    : `structural:${callsiteIndex}`;
}

function getStructuralMeta(meta, callsitePath) {
  const nextMeta = isObject$1(meta) ? { ...meta } : {};
  const normalizedPath = normalizeHookPath(callsitePath);
  if (normalizedPath.length > 0 && !Array.isArray(nextMeta.callsitePath)) {
    nextMeta.callsitePath = normalizedPath;
  }
  return nextMeta;
}

function getEntryCallsitePath(source, callsiteId) {
  return normalizeHookPath(source.callsitePath ?? source.path ?? source.meta?.callsitePath ?? [callsiteId]);
}

function refreshEntryArgsAndMeta(entry, args = null, meta = null) {
  entry.args = Array.isArray(args) ? args : entry.args;
  entry.meta = isObject$1(meta) ? getStructuralMeta(meta, entry.callsitePath) : entry.meta;
  return entry;
}

function getDefinitionMiddlewares(definition) {
  const resolvedDefinition = resolveStructuralDefinition(definition);
  return isObject$1(resolvedDefinition) && isObject$1(resolvedDefinition.middlewares)
    ? resolvedDefinition.middlewares
    : null;
}

function getDefinitionAccessors(definition) {
  const resolvedDefinition = resolveStructuralDefinition(definition);
  return isObject$1(resolvedDefinition) && typeof resolvedDefinition.accessors === "function"
    ? resolvedDefinition.accessors
    : null;
}

function getDefinitionProps(definition) {
  const resolvedDefinition = resolveStructuralDefinition(definition);
  if (!isObject$1(resolvedDefinition)) {
    return null;
  }

  if (typeof resolvedDefinition.props === "function") {
    return resolvedDefinition.props;
  }

  return isObject$1(resolvedDefinition.props)
    ? (_host, _state, _args, _meta, _entry, next) =>
      mergeStructuralProps(next(), resolvedDefinition.props)
    : null;
}


function getDefinitionUse(definition) {
  const resolvedDefinition = resolveStructuralDefinition(definition);
  return isObject$1(resolvedDefinition) && typeof resolvedDefinition.use === "function"
    ? resolvedDefinition.use
    : null;
}

function getDefinitionStatic(definition) {
  const resolvedDefinition = resolveStructuralDefinition(definition);
  return isObject$1(resolvedDefinition) && typeof resolvedDefinition.static === "function"
    ? resolvedDefinition.static
    : null;
}

function getDefinitionCreateState(definition) {
  const resolvedDefinition = resolveStructuralDefinition(definition);
  if (isObject$1(resolvedDefinition) && typeof resolvedDefinition.createState === "function") {
    return resolvedDefinition.createState;
  }
  if (isObject$1(resolvedDefinition) && typeof resolvedDefinition.setup === "function") {
    return resolvedDefinition.setup;
  }
  return null;
}

function getStaticStateCache(owner) {
  if (!owner) {
    return null;
  }
  if (!owner[STRUCTURAL_STATIC_STATE]) {
    Object.defineProperty(owner, STRUCTURAL_STATIC_STATE, {
      value: new Map(),
      configurable: true,
    });
  }
  return owner[STRUCTURAL_STATIC_STATE];
}

function createStaticState(owner, definition, args, meta, entry) {
  const staticReader = getDefinitionStatic(definition);
  if (!staticReader) {
    return undefined;
  }
  return staticReader(...args, meta, entry);
}

function getOrCreateStaticState(owner, definition, args, meta, entry) {
  const cache = getStaticStateCache(owner);
  const key = entry.callsiteId ?? entry.id;
  if (!cache || !key) {
    return createStaticState(owner, definition, args, meta, entry);
  }
  if (!cache.has(key)) {
    cache.set(key, createStaticState(owner, definition, args, meta, entry));
  }
  return cache.get(key);
}

function createEntryState(host, definition, args, meta, entry) {
  if (Object.prototype.hasOwnProperty.call(entry, "state")) {
    return entry.state;
  }

  const staticState = Object.prototype.hasOwnProperty.call(entry, "staticState")
    ? entry.staticState
    : getOrCreateStaticState(host?.constructor, definition, args, meta, entry);
  const createState = getDefinitionCreateState(definition);
  const structuralState = {
    static: staticState,
    instance: undefined,
  };
  if (createState) {
    structuralState.instance = createState(host, args, staticState, meta, entry);
  }

  return structuralState;
}

function normalizeAccessorDescriptor(name, descriptor) {
  if (!isObject$1(descriptor)) {
    throw new TypeError(
      `Structural accessor "${name}" must be an object with get and/or set functions.`
    );
  }

  const hasGet = typeof descriptor.get === "function";
  const hasSet = typeof descriptor.set === "function";

  if (!hasGet && !hasSet) {
    throw new TypeError(
      `Structural accessor "${name}" must define at least a get() or set() function.`
    );
  }

  if (descriptor.get != null && !hasGet) {
    throw new TypeError(`Structural accessor "${name}" received a non-function get descriptor.`);
  }

  if (descriptor.set != null && !hasSet) {
    throw new TypeError(`Structural accessor "${name}" received a non-function set descriptor.`);
  }

  return {
    get: hasGet ? descriptor.get : undefined,
    set: hasSet ? descriptor.set : undefined,
  };
}

function normalizeAccessorMap(rawAccessors) {
  if (rawAccessors == null) {
    return {};
  }
  if (!isObject$1(rawAccessors)) {
    throw new TypeError("Structural hook accessors() must return an object of accessor descriptors.");
  }

  const accessors = {};
  for (const name of Object.keys(rawAccessors)) {
    accessors[name] = normalizeAccessorDescriptor(name, rawAccessors[name]);
  }
  return accessors;
}

function cloneAccessorMap(accessors) {
  return accessors ? { ...accessors } : {};
}

function createStructuralEntryStateView(entry) {
  if (entry?.state) {
    return entry.state;
  }
  return {
    static: entry?.staticState,
    instance: undefined,
  };
}

function resolveEntryAccessors(host, entry, previousAccessors = {}) {
  const accessorsFactory = getDefinitionAccessors(entry?.definition);
  if (!accessorsFactory) {
    return cloneAccessorMap(previousAccessors);
  }

  const next = () => cloneAccessorMap(previousAccessors);
  const rawAccessors = accessorsFactory(host, createStructuralEntryStateView(entry), next);
  const normalized = normalizeAccessorMap(rawAccessors);
  return normalized;
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function mergeStructuralProps(base, override) {
  if (!override) {
    return base;
  }

  const next = { ...(base || {}) };
  for (const key of Object.keys(override)) {
    const baseEntry = next[key];
    const overrideEntry = override[key];

    if (isPlainObject(baseEntry) && isPlainObject(overrideEntry)) {
      next[key] = {
        ...baseEntry,
        ...overrideEntry,
      };
    } else {
      next[key] = overrideEntry;
    }
  }

  return next;
}

function resolveEntryProps(owner, entry) {
  const propsFactory = getDefinitionProps(entry?.definition);
  if (!propsFactory) {
    return entry?.__litsxPreviousProps ?? null;
  }

  const nextBase = entry?.__litsxPreviousProps;
  const next = () => {
    if (nextBase == null) {
      return nextBase;
    }
    return isObject$1(nextBase) ? { ...nextBase } : nextBase;
  };
  const rawProps = propsFactory(owner, createStructuralEntryStateView(entry), next);
  if (rawProps == null) {
    return nextBase ?? null;
  }
  if (!isObject$1(rawProps)) {
    throw new TypeError("Structural hook props() must return an object of property descriptors.");
  }
  return mergeStructuralProps(nextBase, rawProps);
}

function getHostAccessorRegistry(host) {
  if (!isObject$1(host)) {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(host, STRUCTURAL_HOST_ACCESSORS)) {
    Object.defineProperty(host, STRUCTURAL_HOST_ACCESSORS, {
      value: new Map(),
      configurable: true,
    });
  }

  return host[STRUCTURAL_HOST_ACCESSORS];
}

function syncInstalledHostAccessor(host, name, registryEntry) {
  if (typeof registryEntry.getWrapper !== "function") {
    registryEntry.getWrapper = function structuralAccessorGetter() {
      const getter = registryEntry.descriptor?.get;
      return typeof getter === "function" ? getter() : undefined;
    };
  }

  if (typeof registryEntry.setWrapper !== "function") {
    registryEntry.setWrapper = function structuralAccessorSetter(value) {
      const setter = registryEntry.descriptor?.set;
      if (typeof setter === "function") {
        setter(value);
      }
    };
  }

  Object.defineProperty(host, name, {
    get: typeof registryEntry.descriptor?.get === "function"
      ? registryEntry.getWrapper
      : undefined,
    set: typeof registryEntry.descriptor?.set === "function"
      ? registryEntry.setWrapper
      : undefined,
    configurable: true,
  });

  return true;
}

function removeInstalledHostAccessor(host, name) {
  const registry = getHostAccessorRegistry(host);
  const registryEntry = registry?.get(name);
  if (!registryEntry) {
    return;
  }
  delete host[name];
  registry.delete(name);
}

function syncHostAccessors(host, entries) {
  const registry = getHostAccessorRegistry(host);
  if (!registry || !Array.isArray(entries)) {
    return;
  }

  const orderedEntries = entries
    .filter(Boolean)
    .slice()
    .sort((left, right) => (left.callsiteIndex ?? 0) - (right.callsiteIndex ?? 0));

  let nextAccessors = {};
  for (const entry of orderedEntries) {
    nextAccessors = resolveEntryAccessors(host, entry, nextAccessors);
  }

  const owner = host?.constructor ?? host;
  const publicProps = resolveStructuralProps(owner);
  for (const name of Object.keys(nextAccessors)) {
    if (Object.prototype.hasOwnProperty.call(publicProps, name)) {
      throw new TypeError(
        `Structural accessor "${name}" collides with a public structural prop declared through props(). ` +
        "Overrides within props() or within accessors() are allowed, but the same key cannot be declared across both channels. " +
        "Public component properties must be declared only through props(); accessors() is reserved for non-public runtime host capabilities."
      );
    }
  }

  const nextNames = new Set(Object.keys(nextAccessors));
  for (const existingName of Array.from(registry.keys())) {
    if (!nextNames.has(existingName)) {
      removeInstalledHostAccessor(host, existingName);
    }
  }

  for (const name of nextNames) {
    let registryEntry = registry.get(name);

    if (!registryEntry) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(host, name);
      if (ownDescriptor) {
        throw new TypeError(
          `Structural hook cannot install accessor "${name}" because the host already defines that own property.`
        );
      }

      registryEntry = {
        descriptor: null,
        getWrapper: null,
        setWrapper: null,
      };
      registry.set(name, registryEntry);
    }

    registryEntry.descriptor = nextAccessors[name];
    syncInstalledHostAccessor(host, name, registryEntry);
  }
}

function normalizeStructuralEntry(host, entry, index) {
  const source = isObject$1(entry) ? entry : {};
  const callsiteIndex = Number.isInteger(source.callsiteIndex)
    ? source.callsiteIndex
    : index;
  const callsiteId = getStructuralEntryId(source.callsiteId ?? source.id, callsiteIndex);
  const callsitePath = getEntryCallsitePath(source, callsiteId);
  const definition = Object.prototype.hasOwnProperty.call(source, "definition")
    ? source.definition
    : null;
  const args = Array.isArray(source.args) ? source.args : [];
  const meta = getStructuralMeta(source.meta, callsitePath);
  const normalized = {
    id: callsiteId,
    callsiteId,
    callsiteIndex,
    callsitePath,
    definition,
    args,
    meta,
    state: undefined,
    middlewares: isObject$1(source.middlewares)
      ? source.middlewares
      : getDefinitionMiddlewares(definition),
    accessors: {},
  };
  normalized.state = createEntryState(host, definition, args, meta, source);
  return normalized;
}

function resolveHostEntries(host, entries) {
  const source = typeof entries === "function" ? entries(host) : entries;
  return Array.isArray(source) ? source : [];
}

function getHostMiddlewareEntries(host) {
  const ctor = host?.constructor;
  return resolveHostEntries(
    host,
    ctor?.structuralEntries ?? ctor?.__litsxStructuralEntries ?? [],
  );
}

/**
 * Runtime for structural host middleware entries.
 *
 * Entries are one-to-one with authored callsites and are intentionally not
 * deduplicated. Resource-level dedupe belongs in each structural hook runtime.
 * Entries are composed in registration order. For every lifecycle method, the
 * generated host's base implementation is invoked as the final chain link.
 *
 * SSR/client consistency comes from the compiled structural plan: the same
 * authored file and callsite path produce the same entry ids and paths on both
 * sides. This generic runtime does not serialize arbitrary entry state; hooks
 * that own serializable resources should use their stable callsite metadata as
 * the key for their own SSR payloads.
 */
class HostMiddlewareRuntime {
  constructor(host, entries = []) {
    this.host = host;
    this.entries = resolveHostEntries(host, entries).map((entry, index) =>
      normalizeStructuralEntry(host, entry, index)
    );
    syncHostAccessors(this.host, this.entries);
  }

  getEntry(index) {
    return this.entries[index] ?? null;
  }

  findEntryIndexByCallsiteId(callsiteId) {
    return this.entries.findIndex((entry) => entry?.callsiteId === callsiteId);
  }

  ensureEntry(index, entry) {
    const existing = this.entries[index];
    if (existing && existing.callsiteId === (entry?.callsiteId ?? entry?.id)) {
      refreshEntryArgsAndMeta(existing, entry?.args, entry?.meta);
      syncHostAccessors(this.host, this.entries);
      return existing;
    }

    const callsiteId = entry?.callsiteId ?? entry?.id;
    if (typeof callsiteId === "string") {
      const existingIndex = this.findEntryIndexByCallsiteId(callsiteId);
      if (existingIndex >= 0) {
        const existingById = this.entries[existingIndex];
        refreshEntryArgsAndMeta(existingById, entry?.args, entry?.meta);
        syncHostAccessors(this.host, this.entries);
        return existingById;
      }
    }

    const normalized = normalizeStructuralEntry(this.host, entry, index);
    if (existing) {
      this.entries.push(normalized);
    } else {
      this.entries[index] = normalized;
    }
    syncHostAccessors(this.host, this.entries);
    return normalized;
  }

  read(index, args = null, meta = null) {
    const entry = this.getEntry(index);
    if (!entry) {
      throw new RangeError(`Host middleware entry ${index} does not exist.`);
    }

    refreshEntryArgsAndMeta(entry, args, meta);
    const use = getDefinitionUse(entry.definition);

    if (!use) {
      throw new TypeError(`Host middleware entry "${entry.id}" does not define a render-time use() reader.`);
    }

    return use(this.host, entry.state, entry.args, entry.meta, entry);
  }

  run(methodName, argsOrBase, maybeBase) {
    const { args, base } = normalizeInvocation(argsOrBase, maybeBase);
    const chainEntries = this.entries.filter((entry) =>
      typeof entry.middlewares?.[methodName] === "function"
    );

    const dispatch = (index) => {
      if (index >= chainEntries.length) {
        return base();
      }

      const entry = chainEntries[index];
      const middleware = entry.middlewares[methodName];
      let nextCalled = false;
      const next = () => {
        if (nextCalled) {
          throw new Error(`Host middleware "${entry.id}" called next() more than once for ${methodName}.`);
        }
        nextCalled = true;
        return dispatch(index + 1);
      };

      return middleware(this.host, entry.state, next, args, entry.meta, entry);
    };

    return dispatch(0);
  }
}

for (const methodName of LIFECYCLE_METHODS) {
  HostMiddlewareRuntime.prototype[methodName] = function runLifecycle(argsOrBase, maybeBase) {
    return this.run(methodName, argsOrBase, maybeBase);
  };
}

function getOrCreateHostRuntime(host) {
  if (!host.__litsxHostMiddlewareRuntime) {
    host.__litsxHostMiddlewareRuntime = new HostMiddlewareRuntime(
      host,
      getHostMiddlewareEntries(host),
    );
  }
  return host.__litsxHostMiddlewareRuntime;
}

function resolveStructuralEntry(host, callsiteIndex, callsiteId, definition, args = [], meta = {}) {
  const runtime = getOrCreateHostRuntime(host);
  const callsitePath = normalizeHookPath(meta?.callsitePath ?? [callsiteId]);
  const nextMeta = getStructuralMeta(meta, callsitePath);
  const entry = runtime.ensureEntry(callsiteIndex, {
    id: callsiteId,
    callsiteId,
    callsiteIndex,
    callsitePath,
    definition,
    args,
    meta: nextMeta,
  });
  const entryIndex = runtime.entries.indexOf(entry);
  return runtime.read(entryIndex >= 0 ? entryIndex : callsiteIndex, args, nextMeta);
}

function normalizeStaticEntry(owner, entry, index) {
  const source = isObject$1(entry) ? entry : {};
  const callsiteIndex = Number.isInteger(source.callsiteIndex)
    ? source.callsiteIndex
    : index;
  const callsiteId = getStructuralEntryId(source.callsiteId ?? source.id, callsiteIndex);
  const callsitePath = getEntryCallsitePath(source, callsiteId);
  const args = Array.isArray(source.args) ? source.args : [];
  const meta = getStructuralMeta(source.meta, callsitePath);
  const staticEntry = {
    id: callsiteId,
    callsiteId,
    callsiteIndex,
    callsitePath,
    definition: Object.prototype.hasOwnProperty.call(source, "definition")
      ? source.definition
      : null,
    args,
    meta,
  };
  staticEntry.staticState = getOrCreateStaticState(owner, staticEntry.definition, args, meta, staticEntry);
  return staticEntry;
}

function getOrCreateStaticEntries(owner) {
  if (!owner) {
    return [];
  }
  if (!owner.__litsxStructuralStaticEntries) {
    const entries = resolveHostEntries(
      owner,
      owner.structuralStaticEntries ?? owner.__litsxStaticStructuralEntries ?? [],
    );
    Object.defineProperty(owner, "__litsxStructuralStaticEntries", {
      value: entries.map((entry, index) => normalizeStaticEntry(owner, entry, index)),
      configurable: true,
    });
  }
  return owner.__litsxStructuralStaticEntries;
}

function getStructuralPropsCache(owner) {
  if (!owner) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(owner, STRUCTURAL_HOST_PROPS)) {
    Object.defineProperty(owner, STRUCTURAL_HOST_PROPS, {
      value: new Map(),
      configurable: true,
    });
  }
  return owner[STRUCTURAL_HOST_PROPS];
}

function getStructuralClassEntries(owner) {
  return resolveHostEntries(
    owner,
    owner?.structuralEntries ?? owner?.__litsxStructuralEntries ?? [],
  ).map((entry, index) => normalizeStaticEntry(owner, entry, index));
}

function resolveStructuralProps(owner, base = null) {
  if (!owner) {
    return base ?? {};
  }

  const cache = getStructuralPropsCache(owner);
  const cacheKey = base == null ? "__litsx:no-base" : base;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let mergedProps = base;
  const entries = [
    ...getStructuralClassEntries(owner),
    ...getOrCreateStaticEntries(owner),
  ].sort((left, right) => (left.callsiteIndex ?? 0) - (right.callsiteIndex ?? 0));

  for (const entry of entries) {
    entry.__litsxPreviousProps = mergedProps;
    mergedProps = resolveEntryProps(owner, entry);
  }

  const result = mergedProps ?? {};
  cache?.set(cacheKey, result);
  return result;
}

function resolveStructuralStaticEntry(owner, callsiteIndex, callsiteId, definition, args = [], meta = {}) {
  const entries = getOrCreateStaticEntries(owner);
  const existing = entries.find((entry) => entry.callsiteId === callsiteId);
  const callsitePath = normalizeHookPath(meta?.callsitePath ?? [callsiteId]);
  const nextMeta = getStructuralMeta(meta, callsitePath);
  const entry = existing ?? normalizeStaticEntry(owner, {
    id: callsiteId,
    callsiteId,
    callsiteIndex,
    callsitePath,
    definition,
    args,
    meta: nextMeta,
  }, callsiteIndex);
  if (!existing) {
    entries[callsiteIndex] = entry;
  }

  entry.args = Array.isArray(args) ? args : entry.args;
  entry.meta = nextMeta;
  const use = getDefinitionUse(definition);
  const state = {
    static: entry.staticState,
    instance: undefined,
  };
  if (!use) {
    return entry.staticState;
  }
  return use(owner, state, entry.args, entry.meta, entry);
}

function HostMiddlewareMixin(Base) {
  class HostMiddlewareHost extends Base {
    constructor(...args) {
      super(...args);
      this.__litsxHostMiddlewareRuntime = new HostMiddlewareRuntime(
        this,
        getHostMiddlewareEntries(this),
      );
    }

    __litsxReadStructuralEntry(index, args, meta) {
      return getOrCreateHostRuntime(this).read(index, args, meta);
    }

    connectedCallback(...args) {
      return getOrCreateHostRuntime(this).connectedCallback(args, () =>
        typeof super.connectedCallback === "function" ? super.connectedCallback(...args) : undefined
      );
    }

    disconnectedCallback(...args) {
      return getOrCreateHostRuntime(this).disconnectedCallback(args, () =>
        typeof super.disconnectedCallback === "function" ? super.disconnectedCallback(...args) : undefined
      );
    }

    attributeChangedCallback(...args) {
      return getOrCreateHostRuntime(this).attributeChangedCallback(args, () =>
        typeof super.attributeChangedCallback === "function" ? super.attributeChangedCallback(...args) : undefined
      );
    }

    formAssociatedCallback(...args) {
      return getOrCreateHostRuntime(this).formAssociatedCallback(args, () =>
        typeof super.formAssociatedCallback === "function" ? super.formAssociatedCallback(...args) : undefined
      );
    }

    formDisabledCallback(...args) {
      return getOrCreateHostRuntime(this).formDisabledCallback(args, () =>
        typeof super.formDisabledCallback === "function" ? super.formDisabledCallback(...args) : undefined
      );
    }

    formResetCallback(...args) {
      return getOrCreateHostRuntime(this).formResetCallback(args, () =>
        typeof super.formResetCallback === "function" ? super.formResetCallback(...args) : undefined
      );
    }

    formStateRestoreCallback(...args) {
      return getOrCreateHostRuntime(this).formStateRestoreCallback(args, () =>
        typeof super.formStateRestoreCallback === "function" ? super.formStateRestoreCallback(...args) : undefined
      );
    }

    scheduleUpdate(...args) {
      return getOrCreateHostRuntime(this).scheduleUpdate(args, () =>
        typeof super.scheduleUpdate === "function" ? super.scheduleUpdate(...args) : undefined
      );
    }

    shouldUpdate(...args) {
      return getOrCreateHostRuntime(this).shouldUpdate(args, () =>
        typeof super.shouldUpdate === "function" ? super.shouldUpdate(...args) : undefined
      );
    }

    willUpdate(...args) {
      return getOrCreateHostRuntime(this).willUpdate(args, () =>
        typeof super.willUpdate === "function" ? super.willUpdate(...args) : undefined
      );
    }

    update(...args) {
      return getOrCreateHostRuntime(this).update(args, () =>
        typeof super.update === "function" ? super.update(...args) : undefined
      );
    }

    updated(...args) {
      return getOrCreateHostRuntime(this).updated(args, () =>
        typeof super.updated === "function" ? super.updated(...args) : undefined
      );
    }

    firstUpdated(...args) {
      return getOrCreateHostRuntime(this).firstUpdated(args, () =>
        typeof super.firstUpdated === "function" ? super.firstUpdated(...args) : undefined
      );
    }

    getUpdateComplete(...args) {
      return getOrCreateHostRuntime(this).getUpdateComplete(args, () =>
        typeof super.getUpdateComplete === "function" ? super.getUpdateComplete(...args) : undefined
      );
    }
  }

  return HostMiddlewareHost;
}

function createHostMiddlewareRuntime(host, entries = getHostMiddlewareEntries(host)) {
  return new HostMiddlewareRuntime(host, entries);
}

class SsrEffectsController {
  constructor(host, ssrContext) {
    this.host = host;
    this.ssrContext = ssrContext;

    this.memos = [];
    this.memoCursor = 0;
    this.callbacks = [];
    this.callbackCursor = 0;
    this.events = [];
    this.eventCursor = 0;
    this.previousValues = [];
    this.previousCursor = 0;
    this.reducers = [];
    this.reducerCursor = 0;
    this.mutableRefs = [];
    this.mutableRefCursor = 0;
    this.ids = [];
    this.idCursor = 0;
  }

  prepare() {
    this.memoCursor = 0;
    this.callbackCursor = 0;
    this.eventCursor = 0;
    this.previousCursor = 0;
    this.reducerCursor = 0;
    this.mutableRefCursor = 0;
    this.idCursor = 0;
  }

  register() {}

  registerConnected() {}

  registerImperative() {}

  resolveMemo(factory, deps) {
    return resolveMemo(this, factory, deps);
  }

  resolveCallback(callback, deps) {
    return resolveCallback(this, callback, deps);
  }

  resolveEvent(callback) {
    return resolveEvent(this, callback);
  }

  resolvePrevious(value, initialValue) {
    return resolvePrevious(this, value, initialValue);
  }

  resolveReducer(reducer, initialArg, init) {
    const slotIndex = this.reducerCursor;
    const [state] = resolveReducer(this, reducer, initialArg, init);
    this.ssrContext?.context?.collectHydrationState?.({
      rootId: this.ssrContext.rootId,
      instanceId: this.ssrContext.currentInstanceId,
      slot: slotIndex,
      value: state,
    });
    return [state, () => state];
  }

  resolveMutableRef(initialValue) {
    return resolveMutableRef(this, initialValue);
  }

  resolveId() {
    const instanceId = this.ssrContext?.currentInstanceId ?? "0";
    const nextId = `${this.ssrContext?.idPrefix ?? "litsx"}-${instanceId}-${this.idCursor}`;
    this.idCursor += 1;
    return nextId;
  }

  resolveExternalStore(_subscribe, getSnapshot, getServerSnapshot) {
    if (typeof getServerSnapshot === "function") {
      return getServerSnapshot();
    }

    return getSnapshot();
  }

  resolveTransition() {
    return [false, (callback) => callback?.()];
  }

  startTransition(callback) {
    return callback?.();
  }

  resolveDeferredValue(value) {
    return {
      current: value,
      source: value,
      pending: false,
    };
  }
}

const controllers = new WeakMap();
const ssrControllers = new WeakMap();
let currentHookHost = null;

function resolveRuntimeHost(host) {
  if (host && typeof host === "object") {
    return host;
  }

  if (currentHookHost && typeof currentHookHost === "object") {
    return currentHookHost;
  }

  return null;
}

function getController(host) {
  const resolvedHost = resolveRuntimeHost(host);
  if (!resolvedHost) {
    throw new TypeError(
      "Lit<sup>sx</sup> hooks require an active ReactiveControllerHost during render."
    );
  }

  if (resolvedHost[LITSX_SSR_CONTEXT]) {
    let controller = ssrControllers.get(resolvedHost);
    if (!controller) {
      controller = new SsrEffectsController(
        resolvedHost,
        resolvedHost[LITSX_SSR_CONTEXT],
      );
      ssrControllers.set(resolvedHost, controller);
    } else {
      controller.ssrContext = resolvedHost[LITSX_SSR_CONTEXT];
    }
    return controller;
  }

  let controller = controllers.get(resolvedHost);
  if (!controller) {
    controller = new EffectsController(resolvedHost);
    controllers.set(resolvedHost, controller);
  }
  return controller;
}

function prepareEffects(host) {
  const resolvedHost = resolveRuntimeHost(host);
  if (!resolvedHost) {
    throw new TypeError(
      "prepareEffects() requires a ReactiveControllerHost."
    );
  }
  currentHookHost = resolvedHost;
  getController(resolvedHost).prepare();
}

const lazyElementCache = new WeakMap();

function isUsableRegistry(registry) {
  return Boolean(
    registry &&
    typeof registry.define === "function" &&
    typeof registry.get === "function"
  );
}

function getElementRegistryFromRoot(host) {
  if (!host || typeof host.getRootNode !== "function") {
    return null;
  }

  const root = host.getRootNode();
  if (!root || typeof root !== "object") {
    return null;
  }

  return (
    root.registry ??
    root.customElements ??
    root.customElementRegistry ??
    null
  );
}

function getElementRegistry(host) {
  if (!host || typeof host !== "object") {
    return null;
  }

  const directRegistry = host.registry;
  if (isUsableRegistry(directRegistry)) {
    return directRegistry;
  }

  const rootRegistry = getElementRegistryFromRoot(host);
  if (isUsableRegistry(rootRegistry)) {
    return rootRegistry;
  }

  return null;
}

function isCustomElementConstructor(value) {
  if (typeof value !== "function") {
    return false;
  }

  const HTMLElementCtor = globalThis.HTMLElement;
  if (typeof HTMLElementCtor === "function") {
    return value === HTMLElementCtor || value.prototype instanceof HTMLElementCtor;
  }

  return /^class\s/.test(Function.prototype.toString.call(value));
}

function defineScopedElement(registry, tag, ctor) {
  if (!registry || !tag || !ctor) {
    return ctor ?? null;
  }

  const existing = registry.get(tag);
  if (existing) {
    return existing;
  }

  registry.define(tag, ctor);
  return ctor;
}

function resolveLazyLoaderResult(registry, tag, result) {
  if (result == null) {
    return null;
  }

  if (!isCustomElementConstructor(result)) {
    throw new TypeError(
      `ensureLazyElement expected "${tag}" to resolve to a custom element constructor.`
    );
  }

  return defineScopedElement(registry, tag, result);
}

function ensureLazyElement(host, tag, value) {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new TypeError("ensureLazyElement requires a non-empty tag name.");
  }

  const registry = getElementRegistry(host);
  if (!registry) {
    return null;
  }

  const existing = registry.get(tag);
  if (existing) {
    return existing;
  }

  if (value == null) {
    return null;
  }

  if (isCustomElementConstructor(value)) {
    return defineScopedElement(registry, tag, value);
  }

  if (typeof value !== "function") {
    throw new TypeError(
      `ensureLazyElement expected "${tag}" to receive a loader, constructor, or nullish value.`
    );
  }

  let entry = lazyElementCache.get(value);
  if (!entry) {
    entry = {
      status: "fresh",
      result: null,
      error: null,
    };
    lazyElementCache.set(value, entry);
  }

  if (entry.status === "resolved") {
    return resolveLazyLoaderResult(registry, tag, entry.result);
  }

  if (entry.status === "rejected") {
    throw entry.error;
  }

  if (entry.status === "pending") {
    return null;
  }

  entry.status = "pending";
  Promise.resolve()
    .then(() => value())
    .then((result) => {
      entry.status = "resolved";
      entry.result = result;
      resolveLazyLoaderResult(registry, tag, result);
      host?.requestUpdate?.();
      return result;
    })
    .catch((error) => {
      entry.status = "rejected";
      entry.error = error;
      host?.requestUpdate?.();
      throw error;
    });

  return null;
}

/**
 * Run side effects after the host has committed its update.
 * Use this for subscriptions, timers, or synchronizing with systems outside the component tree.
 * Think of useAfterUpdate as the place for work that should happen after Lit<sup>sx</sup> has already committed the latest UI.
 * @usage Call useAfterUpdate when work should happen after the DOM is updated, not during rendering.
 * @usage Return a cleanup function when the effect creates a subscription or any other disposable resource.
 * @behavior The effect runs after the host update cycle completes.
 * @behavior If dependencies change, Lit<sup>sx</sup> runs the previous cleanup before running the next effect.
 * @mentalModel useAfterUpdate is for side effects that observe or connect to the outside world after render has finished. It is not part of the render calculation itself.
 * @pitfall Do not use useAfterUpdate to derive values that the component could compute during render.
 * @pitfall If the effect allocates subscriptions, timers, or handles, return a cleanup function so the host can dispose of them cleanly.
 * @example
 * useAfterUpdate(() => {
 *   const handle = connectToSocket(roomId);
 *   return () => handle.disconnect();
 * }, [roomId]);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {() => void | (() => void)} callback Effect logic to run after commit. May return a cleanup function.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that control when the effect is re-run.
 */
function useAfterUpdate(host, callback, deps) {
  getController(host).register(
    callback,
    Array.isArray(deps) ? deps : deps ?? null,
    false
  );
}

/**
 * Run synchronous commit-phase work before the browser paints the next frame.
 * Use this when the effect must read layout or apply imperative DOM work immediately after commit.
 * Think of useOnCommit as the place for DOM work that is part of committing the frame, not for general side effects.
 * @usage Call useOnCommit for measurement, focus management, or DOM synchronization that should not wait for a later frame.
 * @usage Prefer useAfterUpdate for non-visual side effects so commit work stays small.
 * @usage Keep the callback short and focused on DOM work that must happen immediately after commit.
 * @behavior The effect runs during the host commit phase, before passive effects are flushed.
 * @behavior Cleanup runs before the next committed version of the effect and when the host disconnects.
 * @behavior Expensive work in useOnCommit lengthens the commit path for the current host, so reserve it for work that cannot wait.
 * @mentalModel useOnCommit sits on the critical path between "the DOM just updated" and "the browser can paint". Use it when timing matters.
 * @pitfall Avoid network work, heavy computation, or long-running tasks in useOnCommit. They delay visual updates for the current host.
 * @pitfall Prefer useAfterUpdate if the effect can happen a little later without affecting what the user sees in the current frame.
 * @example
 * useOnCommit(() => {
 *   if (shouldFocus) {
 *     inputRef.current?.focus();
 *   }
 * }, []);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {() => void | (() => void)} callback Commit-phase logic to run immediately after the DOM update.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that control when the effect is re-run.
 */
function useOnCommit(host, callback, deps) {
  getController(host).register(
    callback,
    Array.isArray(deps) ? deps : deps ?? null,
    true
  );
}

/**
 * Run setup when the host is connected to the DOM, and dispose it when the host disconnects.
 * Use this for global event listeners, subscriptions, observers, or resources that should only exist while the host is mounted.
 * Think of useOnConnect as the lifecycle-aware place for work that follows the host's connection to the DOM, not its render timing.
 * @usage Call useOnConnect for resources tied to being connected, such as `window` listeners or store subscriptions.
 * @usage Return a cleanup function to release the resource when the host disconnects, is adopted into a new document, or re-arms due to dependency changes.
 * @behavior The callback runs once when the host becomes active and re-runs only when dependencies change while connected.
 * @behavior Cleanup runs before a dependency-driven re-arm, on disconnect, and when the host is adopted into a new document.
 * @mentalModel useOnConnect is about mount lifetime. It is not for DOM measurement and it is not part of the render/commit path.
 * @pitfall Prefer useOnCommit when the work must happen immediately after the DOM commits, and prefer useAfterUpdate for passive post-update effects.
 * @example
 * useOnConnect(() => {
 *   window.addEventListener("message", onMessage);
 *   return () => window.removeEventListener("message", onMessage);
 * }, []);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {() => void | (() => void)} callback Setup logic to run while the host is connected.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that control when the setup should be re-armed.
 */
function useOnConnect(host, callback, deps) {
  getController(host).registerConnected(
    callback,
    Array.isArray(deps) ? deps : deps ?? []
  );
}

/**
 * Memoize a derived value until its dependencies change.
 * Think of useMemoValue as a render-time memo for expensive derived values.
 * @usage Use useMemoValue when a derived value is expensive enough that recalculating it every render would add noise or cost.
 * @usage Keep the factory pure and derive the value only from the dependencies you pass in.
 * @usage Reach for useMemoValue when a value is derived from props or state, not when you need to persist mutable state between renders.
 * @behavior Lit<sup>sx</sup> compares dependencies with Object.is semantics.
 * @behavior If no dependency array is provided, the value is recomputed on every render.
 * @behavior The factory runs during render, so it should stay synchronous and free of side effects.
 * @mentalModel useMemoValue does not store new state. It remembers the last derived result for the current dependency set.
 * @pitfall Do not use useMemoValue for side effects or asynchronous work. The factory belongs to render and should stay pure.
 * @pitfall If the value is cheap to compute, adding caching can make the component harder to read without delivering much benefit.
 * @example
 * const visibleRows = useMemoValue(
 *   () => rows.filter((row) => row.matches(query)),
 *   [rows, query]
 * );
 * @param {import('lit').ReactiveControllerHost} host
 * @param {() => unknown} factory Function that computes the cached value.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that decide when the cached value becomes stale.
 * @returns {unknown} The cached value for the current dependency set.
 */
function useMemoValue(host, factory, deps) {
  return getController(host).resolveMemo(factory, deps);
}

/**
 * Keep a callback stable until its dependencies change.
 * Think of useStableCallback as a stable function reference for places where callback identity matters.
 * @usage Use useStableCallback when you want a callback value to stay referentially stable across renders.
 * @usage This is most useful when the callback is passed to another hook, an imperative API, or a child component that keys off identity.
 * @usage Prefer useStableCallback when identity stability matters. If a callback is only used inline in the same render path, a plain function is often enough.
 * @behavior The returned function keeps the same identity until one of the listed dependencies changes.
 * @behavior Use this to avoid downstream work caused by unstable callback references.
 * @behavior The callback body is still recreated from the current render when dependencies change, so include every reactive value the callback reads.
 * @mentalModel useStableCallback is about preserving callback identity, not caching results. Use it when changing function references would cause other parts of the UI to do unnecessary work.
 * @pitfall Do not wrap every callback in useStableCallback by default. If nothing observes callback identity, a plain inline function is usually clearer.
 * @pitfall Dependencies still matter. If the callback reads reactive values, include them so the stable callback does not observe stale data.
 * @example
 * const handleSelect = useStableCallback((id) => {
 *   setSelectedId(id);
 *   trackSelection(id);
 * }, [setSelectedId, trackSelection]);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {Function} callback Callback whose identity should remain stable between renders.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that decide when a new callback should be produced.
 * @returns {Function} A callback with stable identity for the current dependency set.
 */
function useStableCallback(host, callback, deps) {
  return getController(host).resolveCallback(callback, deps);
}

/**
 * Keep an event callback identity stable while always calling the latest logic.
 * Think of useEvent as the bridge between connected imperative listeners and the latest render state.
 * @usage Use useEvent when a callback is registered once with an external API but still needs fresh props or state.
 * @usage This is most useful together with useOnConnect for window listeners, observers, timers, or other imperative subscriptions.
 * @behavior The returned function keeps the same identity across renders.
 * @behavior Each call delegates to the latest callback from the current render.
 * @mentalModel useEvent gives outside code a stable function handle, while Lit<sup>sx</sup> keeps swapping the implementation behind it as renders happen.
 * @pitfall useEvent does not register or clean up anything by itself. Pair it with useOnConnect or another lifecycle hook when you need subscription management.
 * @example
 * const onKeyDown = useEvent((event) => {
 *   if (event.key === "Escape" && open) {
 *     setOpen(false);
 *   }
 * });
 *
 * useOnConnect(() => {
 *   window.addEventListener("keydown", onKeyDown);
 *   return () => window.removeEventListener("keydown", onKeyDown);
 * }, []);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {Function} callback Event callback whose body should stay fresh.
 * @returns {Function} A stable callback reference that always delegates to the latest callback.
 */
function useEvent(host, callback) {
  return getController(host).resolveEvent(callback);
}

/**
 * Emit a CustomEvent from the current host without reaching for this.dispatchEvent(...).
 * Think of useEmit as the small authored bridge between component logic and public DOM events.
 * @usage Use useEmit when a component needs to publish a DOM event as part of its public API.
 * @usage This is a good fit for input-like controls, disclosure widgets, and selection components.
 * @behavior The returned function keeps a stable identity across renders.
 * @behavior Events default to `{ bubbles: true, composed: true, cancelable: false }`.
 * @behavior Passing options overrides those defaults without replacing the rest of the event init object.
 * @mentalModel useEmit keeps event emission explicit in authored code while still lowering directly to the native CustomEvent model.
 * @pitfall useEmit publishes events; it does not make internal values reactive for parents by itself.
 * @example
 * const emit = useEmit();
 *
 * emit("change", value);
 * emit("submit", value, { cancelable: true });
 * @param {import('lit').ReactiveControllerHost & EventTarget} host
 * @returns {(type: string, detail?: unknown, options?: { bubbles?: boolean; composed?: boolean; cancelable?: boolean }) => boolean}
 */
function useEmit(host) {
  return useEvent(host, (type, detail, options = {}) =>
    host.dispatchEvent(
      new CustomEvent(type, {
        detail,
        bubbles: options.bubbles ?? true,
        composed: options.composed ?? true,
        cancelable: options.cancelable ?? false,
      })
    )
  );
}

const FACE_INTERNALS = Symbol.for("litsx.face.internals");
const FACE_SHARED_STATE = Symbol.for("litsx.face.sharedState");
const FORM_VALUE_OWNER = Symbol.for("litsx.formValue.owner");
const VALIDITY_FIELDS = [
  "badInput",
  "customError",
  "patternMismatch",
  "rangeOverflow",
  "rangeUnderflow",
  "stepMismatch",
  "tooLong",
  "tooShort",
  "typeMismatch",
  "valid",
  "valueMissing",
];
const DEFAULT_VALIDITY = Object.freeze({
  badInput: false,
  customError: false,
  patternMismatch: false,
  rangeOverflow: false,
  rangeUnderflow: false,
  stepMismatch: false,
  tooLong: false,
  tooShort: false,
  typeMismatch: false,
  valid: true,
  valueMissing: false,
});

function isObject(value) {
  return value !== null && typeof value === "object";
}

function ensureInternals(host) {
  if (!host || typeof host.attachInternals !== "function") {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(host, FACE_INTERNALS)) {
    return host[FACE_INTERNALS];
  }

  try {
    const internals = host.attachInternals();
    host[FACE_INTERNALS] = internals ?? null;
    return host[FACE_INTERNALS];
  } catch {
    host[FACE_INTERNALS] = null;
    return null;
  }
}

function cloneValiditySnapshot(validity) {
  const snapshot = { ...DEFAULT_VALIDITY };
  if (!isObject(validity)) {
    return snapshot;
  }
  for (const field of VALIDITY_FIELDS) {
    if (field === "valid") {
      snapshot.valid = validity.valid !== false;
      continue;
    }
    snapshot[field] = validity[field] === true;
  }
  return snapshot;
}

function sameValiditySnapshot(left, right) {
  return VALIDITY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function readValidationMessage(internals) {
  return typeof internals?.validationMessage === "string"
    ? internals.validationMessage
    : "";
}

function readWillValidate(internals) {
  return internals?.willValidate === true;
}

function createSharedFaceState(host) {
  const internals = ensureInternals(host);
  return {
    supported: internals !== null,
    internals,
    form: null,
    disabled: false,
    validity: cloneValiditySnapshot(internals?.validity),
    validationMessage: readValidationMessage(internals),
    willValidate: readWillValidate(internals),
  };
}

function getOrCreateFaceState(host) {
  if (!isObject(host)) {
    return createSharedFaceState(host);
  }

  if (!Object.prototype.hasOwnProperty.call(host, FACE_SHARED_STATE)) {
    host[FACE_SHARED_STATE] = createSharedFaceState(host);
  }

  return host[FACE_SHARED_STATE];
}

function requestHostUpdate(host) {
  host?.requestUpdate?.();
}

function syncInternalsValue(internals, value, state = value) {
  if (typeof internals?.setFormValue !== "function") {
    return;
  }

  const nextValue = value === undefined ? null : value;

  try {
    internals.setFormValue(nextValue, state);
  } catch {
    internals.setFormValue(nextValue);
  }
}

function updateSharedValiditySnapshot(sharedState) {
  const nextValidity = cloneValiditySnapshot(sharedState.internals?.validity);
  const nextValidationMessage = readValidationMessage(sharedState.internals);
  const nextWillValidate = readWillValidate(sharedState.internals);
  const changed =
    !sameValiditySnapshot(sharedState.validity, nextValidity) ||
    sharedState.validationMessage !== nextValidationMessage ||
    sharedState.willValidate !== nextWillValidate;

  if (!changed) {
    return false;
  }

  sharedState.validity = nextValidity;
  sharedState.validationMessage = nextValidationMessage;
  sharedState.willValidate = nextWillValidate;
  return true;
}

function refreshSharedValidity(host, sharedState) {
  const changed = updateSharedValiditySnapshot(sharedState);
  if (!changed) {
    return false;
  }

  requestHostUpdate(host);
  return true;
}

function createFaceHostAccessors(shared) {
  return {
    form: {
      get: () => shared.internals?.form ?? shared.form,
    },
    validity: {
      get: () => cloneValiditySnapshot(shared.internals?.validity ?? shared.validity),
    },
    validationMessage: {
      get: () => {
        if (shared.internals) {
          return readValidationMessage(shared.internals);
        }
        return shared.validationMessage;
      },
    },
    willValidate: {
      get: () => {
        if (shared.internals) {
          return readWillValidate(shared.internals);
        }
        return shared.willValidate;
      },
    },
  };
}

const useElementInternals = defineHook({
  setup(host) {
    return {
      shared: getOrCreateFaceState(host),
    };
  },

  accessors(_host, state, next) {
    return {
      ...next(),
      ...createFaceHostAccessors(state.instance.shared),
    };
  },

  use(_host, state) {
    return {
      supported: state.instance.shared.supported,
      internals: state.instance.shared.internals,
    };
  },
});

const useFormValue = defineHook({
  setup(host, args, _staticState, _meta, entry) {
    const shared = getOrCreateFaceState(host);
    const existingOwner = host?.[FORM_VALUE_OWNER];
    if (existingOwner && existingOwner !== entry?.callsiteId) {
      throw new Error(
        "useFormValue can only be called once per component host because form-associated controls expose a single form value interface."
      );
    }

    if (host && typeof host === "object") {
      host[FORM_VALUE_OWNER] = entry?.callsiteId ?? true;
    }

    const initialValue = args[0];
    syncInternalsValue(shared.internals, initialValue, initialValue);

    return {
      shared,
      value: initialValue,
      defaultValue: initialValue,
      restoreState: null,
      restoreMode: null,
    };
  },

  accessors(_host, state, next) {
    return {
      ...next(),
      ...createFaceHostAccessors(state.instance.shared),
    };
  },

  middlewares: {
    formAssociatedCallback(host, state, next, args) {
      const [form] = args;
      if (!Object.is(state.instance.shared.form, form)) {
        state.instance.shared.form = form;
        requestHostUpdate(host);
      }
      return next();
    },

    formDisabledCallback(host, state, next, args) {
      const [disabled] = args;
      if (!Object.is(state.instance.shared.disabled, disabled)) {
        state.instance.shared.disabled = disabled;
        requestHostUpdate(host);
      }
      return next();
    },

    formResetCallback(host, state, next) {
      const valueChanged = !Object.is(state.instance.value, state.instance.defaultValue);
      const restoreChanged = state.instance.restoreState !== null || state.instance.restoreMode !== null;

      state.instance.value = state.instance.defaultValue;
      state.instance.restoreState = null;
      state.instance.restoreMode = null;
      syncInternalsValue(
        state.instance.shared.internals,
        state.instance.defaultValue,
        state.instance.defaultValue
      );

      if (valueChanged || restoreChanged) {
        requestHostUpdate(host);
      }
      return next();
    },

    formStateRestoreCallback(host, state, next, args) {
      const [restoredState, mode] = args;
      const valueChanged = !Object.is(state.instance.value, restoredState);
      const restoreChanged =
        !Object.is(state.instance.restoreState, restoredState) ||
        state.instance.restoreMode !== mode;

      state.instance.value = restoredState;
      state.instance.restoreState = restoredState;
      state.instance.restoreMode = mode;
      syncInternalsValue(state.instance.shared.internals, restoredState, restoredState);

      if (valueChanged || restoreChanged) {
        requestHostUpdate(host);
      }
      return next();
    },
  },

  use(host, state) {
    const setValue = useEvent(host, (next) => {
      const resolvedValue = typeof next === "function"
        ? next(state.instance.value)
        : next;

      if (Object.is(state.instance.value, resolvedValue)) {
        return resolvedValue;
      }

      state.instance.value = resolvedValue;
      syncInternalsValue(state.instance.shared.internals, resolvedValue, resolvedValue);
      requestHostUpdate(host);
      return resolvedValue;
    });

    const setDefaultValue = useEvent(host, (next) => {
      const resolvedValue = typeof next === "function"
        ? next(state.instance.defaultValue)
        : next;

      if (Object.is(state.instance.defaultValue, resolvedValue)) {
        return resolvedValue;
      }

      state.instance.defaultValue = resolvedValue;
      requestHostUpdate(host);
      return resolvedValue;
    });

    const setFormValue = useEvent(host, (value, restoreState = state.instance.value) => {
      syncInternalsValue(state.instance.shared.internals, value, restoreState);
    });

    return {
      form: state.instance.shared.form,
      disabled: state.instance.shared.disabled,
      value: state.instance.value,
      defaultValue: state.instance.defaultValue,
      restoreState: state.instance.restoreState,
      restoreMode: state.instance.restoreMode,
      setValue,
      setDefaultValue,
      setFormValue,
    };
  },
});

const useFormValidity = defineHook({
  setup(host) {
    return {
      shared: getOrCreateFaceState(host),
    };
  },

  accessors(_host, state, next) {
    return {
      ...next(),
      ...createFaceHostAccessors(state.instance.shared),
    };
  },

  middlewares: {
    formAssociatedCallback(host, state, next, args) {
      const [form] = args;
      const formChanged = !Object.is(state.instance.shared.form, form);

      if (formChanged) {
        state.instance.shared.form = form;
      }

      const validityChanged = updateSharedValiditySnapshot(state.instance.shared);
      if (formChanged || validityChanged) {
        requestHostUpdate(host);
      }
      return next();
    },

    formDisabledCallback(host, state, next, args) {
      const [disabled] = args;
      const disabledChanged = !Object.is(state.instance.shared.disabled, disabled);

      if (disabledChanged) {
        state.instance.shared.disabled = disabled;
      }

      const validityChanged = updateSharedValiditySnapshot(state.instance.shared);
      if (disabledChanged || validityChanged) {
        requestHostUpdate(host);
      }
      return next();
    },
  },

  use(host, state) {
    updateSharedValiditySnapshot(state.instance.shared);

    const setValidity = useEvent(host, (flags = {}, message = "", anchor) => {
      if (typeof state.instance.shared.internals?.setValidity !== "function") {
        return;
      }

      if (anchor !== undefined) {
        state.instance.shared.internals.setValidity(flags ?? {}, message, anchor);
      } else if (message !== undefined) {
        state.instance.shared.internals.setValidity(flags ?? {}, message);
      } else {
        state.instance.shared.internals.setValidity(flags ?? {});
      }

      refreshSharedValidity(host, state.instance.shared);
    });

    const checkValidity = useEvent(host, () => {
      if (typeof state.instance.shared.internals?.checkValidity !== "function") {
        return true;
      }
      const result = state.instance.shared.internals.checkValidity();
      refreshSharedValidity(host, state.instance.shared);
      return result;
    });

    const reportValidity = useEvent(host, () => {
      if (typeof state.instance.shared.internals?.reportValidity !== "function") {
        return true;
      }
      const result = state.instance.shared.internals.reportValidity();
      refreshSharedValidity(host, state.instance.shared);
      return result;
    });

    return {
      supported: state.instance.shared.supported,
      willValidate: state.instance.shared.willValidate,
      validity: state.instance.shared.validity,
      validationMessage: state.instance.shared.validationMessage,
      setValidity,
      checkValidity,
      reportValidity,
    };
  },
});

function isReactiveControllerHostLike(value) {
  return !!value
    && typeof value === "object"
    && typeof value.addController === "function";
}

function readHostSlotName(node) {
  if (!node || typeof node !== "object") {
    return "default";
  }

  if (typeof node.slot === "string" && node.slot) {
    return node.slot;
  }

  if (typeof node.getAttribute === "function") {
    const slotName = node.getAttribute("slot");
    if (typeof slotName === "string" && slotName) {
      return slotName;
    }
  }

  return "default";
}

function readHostTextContent(host) {
  if (typeof host?.textContent === "string") {
    return host.textContent;
  }

  const nodes = Array.isArray(host?.childNodes) ? host.childNodes : Array.from(host?.childNodes ?? []);
  return nodes.map((node) => node?.textContent ?? "").join("");
}

function createHostContentSnapshot(host, options = {}) {
  const nodes = Array.from(host?.childNodes ?? []);
  const rawText = readHostTextContent(host);
  const text = options.trim ? rawText.trim() : rawText;
  const slots = { default: [] };

  for (const node of nodes) {
    const slotName = readHostSlotName(node);
    if (!slots[slotName]) {
      slots[slotName] = [];
    }
    slots[slotName].push(node);
  }

  const hasContent = nodes.some((node) => {
    if (!node || typeof node !== "object") {
      return false;
    }

    if (node.nodeType === 3) {
      return String(node.textContent ?? "").trim().length > 0;
    }

    return true;
  });

  return {
    text,
    nodes,
    hasContent,
    slots,
  };
}

function isSameHostContentSnapshot(prev, next) {
  if (prev === next) {
    return true;
  }

  if (!prev || !next) {
    return false;
  }

  if (prev.text !== next.text || prev.hasContent !== next.hasContent) {
    return false;
  }

  if (prev.nodes.length !== next.nodes.length) {
    return false;
  }

  for (let index = 0; index < prev.nodes.length; index += 1) {
    if (prev.nodes[index] !== next.nodes[index]) {
      return false;
    }
  }

  const prevSlotNames = Object.keys(prev.slots);
  const nextSlotNames = Object.keys(next.slots);
  if (prevSlotNames.length !== nextSlotNames.length) {
    return false;
  }

  for (const slotName of prevSlotNames) {
    if (!next.slots[slotName]) {
      return false;
    }

    const prevNodes = prev.slots[slotName];
    const nextNodes = next.slots[slotName];
    if (prevNodes.length !== nextNodes.length) {
      return false;
    }

    for (let index = 0; index < prevNodes.length; index += 1) {
      if (prevNodes[index] !== nextNodes[index]) {
        return false;
      }
    }
  }

  return true;
}

const INITIAL_ASYNC_STATE = Symbol("litsx.initialAsyncState");

function useAsyncStateImpl(
  host,
  initialState,
  action,
  useState,
  useTransition,
  useRef
) {
  if (typeof action !== "function") {
    throw new TypeError("useAsyncState expects an action function");
  }

  const [state, setState] = useState(host, initialState);
  const [error, setError] = useState(host, null);
  const [pending, beginTransition] = useTransition(host);
  const initialStateRef = useRef(host, INITIAL_ASYNC_STATE);
  const stateRef = useRef(host, state);
  const latestRunRef = useRef(host, 0);

  if (initialStateRef.current === INITIAL_ASYNC_STATE) {
    initialStateRef.current = state;
  }

  stateRef.current = state;

  const run = useEvent(host, (...args) => {
    const runId = latestRunRef.current + 1;
    latestRunRef.current = runId;
    setError(null);

    let result;
    try {
      result = beginTransition(() => action(stateRef.current, ...args));
    } catch (nextError) {
      if (runId === latestRunRef.current) {
        setError(nextError);
      }
      return Promise.reject(nextError);
    }

    return Promise.resolve(result).then(
      (nextState) => {
        if (runId === latestRunRef.current) {
          stateRef.current = nextState;
          setError(null);
          setState(nextState);
        }
        return nextState;
      },
      (nextError) => {
        if (runId === latestRunRef.current) {
          setError(nextError);
        }
        return Promise.reject(nextError);
      }
    );
  });

  const reset = useEvent(host, () => {
    latestRunRef.current += 1;
    stateRef.current = initialStateRef.current;
    setError(null);
    setState(initialStateRef.current);
  });

  return [state, run, { pending, error, reset }];
}

function useOptimisticImpl(host, state, updateFn, useRef, useState) {
  const reducer = typeof updateFn === "function"
    ? updateFn
    : (_currentState, optimisticValue) => optimisticValue;
  const baseStateRef = useRef(host, state);
  const queueRef = useRef(host, []);
  const [, forceRender] = useState(host, 0);

  if (!Object.is(baseStateRef.current, state)) {
    baseStateRef.current = state;
    queueRef.current = [];
  }

  const addOptimistic = useEvent(host, (optimisticValue) => {
    queueRef.current = [...queueRef.current, optimisticValue];
    forceRender((version) => version + 1);
  });

  const resetOptimistic = useEvent(host, () => {
    if (queueRef.current.length === 0) {
      return;
    }
    queueRef.current = [];
    forceRender((version) => version + 1);
  });

  const optimisticState = queueRef.current.reduce(
    (currentState, optimisticValue) => reducer(currentState, optimisticValue),
    state
  );

  return [optimisticState, addOptimistic, resetOptimistic];
}

function useTransitionImpl(host) {
  return getController(host).resolveTransition();
}

function startTransitionImpl(host, callback) {
  return getController(host).startTransition(callback);
}

function useDeferredValueImpl(host, value, options) {
  const slot = getController(host).resolveDeferredValue(value, options);
  return slot.pending ? slot.current : slot.source;
}

function isExposeMethodSurface(handle) {
  if (handle === null || typeof handle !== "object") {
    throw new TypeError("useExpose expects createHandle() to return an object of imperative methods.");
  }

  for (const [name, value] of Object.entries(handle)) {
    if (typeof value !== "function") {
      throw new TypeError(`useExpose only supports imperative methods. Received non-function member "${name}".`);
    }
  }

  return handle;
}

function useRefImpl(host, initialValue) {
  return getController(host).resolveMutableRef(initialValue);
}

function useIdImpl(host) {
  return getController(host).resolveId();
}

function useStableIdImpl(_host, callsiteId) {
  if (typeof callsiteId === "string" && callsiteId.length > 0) {
    return callsiteId;
  }

  return "litsx-stable-untransformed";
}

function useCallbackRefImpl(host, getTarget, callback, deps) {
  if (typeof getTarget !== "function") {
    throw new TypeError("useCallbackRef expects a getter function");
  }
  if (typeof callback !== "function") {
    return;
  }

  const boundCallback = (node) => callback.call(host, node);

  getController(host).registerImperative(
    boundCallback,
    () => getTarget.call(host) ?? null,
    deps
  );
}

function useExposeImpl(host, refOrCreateHandle, maybeCreateHandle, maybeDeps) {
  if (typeof maybeCreateHandle === "function") {
    getController(host).registerExposeRef(
      refOrCreateHandle,
      () => isExposeMethodSurface(maybeCreateHandle()),
      maybeDeps
    );
    return;
  }

  getController(host).registerExpose(
    () => isExposeMethodSurface(refOrCreateHandle()),
    maybeCreateHandle
  );
}

function useExternalStoreImpl(host, subscribe, getSnapshot, getServerSnapshot) {
  if (typeof subscribe !== "function") {
    throw new TypeError("useExternalStore requires a subscribe function.");
  }
  if (typeof getSnapshot !== "function") {
    throw new TypeError("useExternalStore requires a getSnapshot function.");
  }
  return getController(host).resolveExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
}

/**
 * Read the value from the previous render.
 * Think of usePrevious as the smallest way to compare the current render against the last committed render state.
 * @usage Use usePrevious when a render needs to compare the current value with what the component saw on the previous render.
 * @usage Pass an initialValue when the first render should not receive undefined.
 * @behavior The first render returns the provided initialValue, or undefined when no initialValue is given.
 * @behavior After that, each render receives the value that was passed on the immediately preceding render.
 * @mentalModel usePrevious lets the current render look one frame back without turning that old value into reactive state.
 * @pitfall usePrevious is for comparisons and derived render logic. It does not trigger updates by itself.
 * @example
 * const previousOpen = usePrevious(open);
 *
 * const becameOpen = open && !previousOpen;
 * @param {import('lit').ReactiveControllerHost} host
 * @param {unknown} value Current render value to track.
 * @param {unknown} [initialValue] Value returned on the first render before any previous value exists.
 * @returns {unknown} The previous render's value, or initialValue on the first render.
 */
function usePrevious(host, value, initialValue) {
  return getController(host).resolvePrevious(value, initialValue);
}

/**
 * Manage local state with a reducer.
 * Think of useReducedState as a way to centralize several related transitions behind explicit actions.
 * @usage Use useReducedState when updates are easier to describe as actions flowing through a reducer than as direct assignments.
 * @usage This is a good fit for state machines, forms, and components with several related state transitions.
 * @usage Prefer useState for isolated values. Reach for useReducedState when several transitions must stay centralized and explicit.
 * @behavior The reducer receives the previous state and the dispatched action and returns the next state.
 * @behavior The optional initializer runs once to derive the initial state from initialArg.
 * @behavior Dispatching an action schedules an update for the current host with the reducer result as the next state.
 * @mentalModel The reducer is the single place that explains how this slice of state changes over time. Actions describe events; the reducer decides the next state.
 * @pitfall If state transitions are simple direct assignments, useState is usually easier to read.
 * @pitfall Keep reducers deterministic and side-effect free. They run as part of deciding the next render state.
 * @example
 * const [panel, dispatch] = useReducedState(panelReducer, {
 *   open: false,
 *   section: "details",
 * });
 *
 * dispatch({ type: "open", section: "activity" });
 * @param {import('lit').ReactiveControllerHost} host
 * @param {(state: any, action: any) => any} reducer Reducer that maps the previous state and an action to the next state.
 * @param {any} initialArg Initial value passed directly to the reducer state or to the initializer.
 * @param {(arg: any) => any} [init] Optional initializer that derives the starting state from initialArg.
 * @returns {[any, (action: any) => void]} The current state and a dispatch function that sends actions to the reducer.
 */
function useReducedState(host, reducer, initialArg, init) {
  return getController(host).resolveReducer(reducer, initialArg, init);
}

/**
 * Store local component state.
 * Think of useState as the default way to keep component-owned UI state alive across renders.
 * @usage Use useState for straightforward local state such as toggles, counters, or small pieces of component-owned UI data.
 * @usage Pass a function when the initial value should be computed only once for the host instance.
 * @usage Prefer useState when the next value can be described directly. Move to useReducedState when state transitions become coupled or action-shaped.
 * @behavior The setter accepts either the next value or an updater function that receives the previous value.
 * @behavior The initial value is created once per host instance, not on every render.
 * @behavior Calling the setter schedules an update for the current host with the next state value.
 * @mentalModel useState gives a component one remembered value and the function that replaces it. Reach for it first when the UI just needs to remember "what is the current value of X?".
 * @pitfall Do not mirror derived data into useState if it can be recomputed from props or other state during render.
 * @pitfall When the next value depends on the previous one, prefer the updater form so the transition stays explicit.
 * @example
 * const [expanded, setExpanded] = useState(false);
 * const toggle = () => setExpanded((value) => !value);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {any | (() => any)} initialState Initial state value, or a function that lazily computes it once.
 * @returns {[any, (next: any | ((value: any) => any)) => void]} The current state and a setter for the next value.
 */
function useState(host, initialState) {
  const hasInitializer = typeof initialState === "function";
  const reducer = (prev, action) =>
    typeof action === "function" ? action(prev) : action;
  const [value, dispatch] = useReducedState(
    host,
    reducer,
    initialState,
    hasInitializer ? (initializer) => initializer() : undefined
  );
  const setValue = (next) => dispatch(next);
  return [value, setValue];
}

/**
 * Manage a value that can be controlled from props or owned locally by the component.
 * Think of useControlledState as the small bridge between component-internal state and design-system APIs that may also be driven from outside.
 * @usage Use useControlledState for patterns such as `value/defaultValue/onChange`, `open/defaultOpen/onOpenChange`, or `checked/defaultChecked/onCheckedChange`.
 * @usage Prefer plain useState when the component always owns the value itself.
 * @behavior When `value` is not undefined, the hook reads from that controlled value and does not update local state.
 * @behavior When `value` is undefined, the hook stores local state initialized from `defaultValue`.
 * @behavior The setter always resolves the next value, updates local state only when uncontrolled, and calls `onChange` when the value actually changes.
 * @mentalModel The hook exposes one current value and one setter, regardless of whether the source of truth lives inside the component or outside it.
 * @pitfall This hook treats `undefined` as the uncontrolled case. Use `null` when the controlled value needs an explicit "empty" state.
 * @pitfall Do not mirror a controlled value into separate component state. This hook already resolves that split.
 * @example
 * const [open, setOpen] = useControlledState({
 *   value: openProp,
 *   defaultValue: false,
 *   onChange: onOpenChange,
 * });
 * @param {import('lit').ReactiveControllerHost} host
 * @param {{ value?: any, defaultValue?: any, onChange?: (value: any) => void }} options
 * @returns {[any, (next: any | ((value: any) => any)) => void]}
 */
function useControlledState(host, options) {
  const isControlled = options.value !== undefined;
  const [internalValue, setInternalValue] = useState(host, options.defaultValue);
  const currentValue = isControlled ? options.value : internalValue;

  const setValue = useEvent(host, (next) => {
    if (isControlled) {
      const resolvedValue = typeof next === "function"
        ? next(currentValue)
        : next;

      if (!Object.is(currentValue, resolvedValue)) {
        options.onChange?.(resolvedValue);
      }
      return;
    }

    if (typeof next === "function") {
      setInternalValue((previousValue) => {
        const resolvedValue = next(previousValue);
        if (!Object.is(previousValue, resolvedValue)) {
          options.onChange?.(resolvedValue);
        }
        return resolvedValue;
      });
      return;
    }

    if (!Object.is(currentValue, next)) {
      options.onChange?.(next);
    }
    setInternalValue(next);
  });

  return [currentValue, setValue];
}

/**
 * Manage async state transitions behind a single run function.
 * Think of useAsyncState as the native Lit<sup>sx</sup> primitive for async mutations that need state, pending, and error tracking together.
 * @usage Use useAsyncState when a user action triggers synchronous or asynchronous work that should eventually commit the next state.
 * @usage The action receives the latest committed state and any arguments passed to run(...).
 * @usage Keep optimistic UI separate. useAsyncState models authoritative async state, not temporary optimistic overlays.
 * @behavior run(...) always returns a Promise, even when the action is synchronous.
 * @behavior pending is derived from the host-scoped transition machinery.
 * @behavior Only the latest started run may commit state or error changes. Older completions are ignored for hook state.
 * @behavior reset() restores the initial state, clears the latest error, and invalidates any in-flight completions.
 * @mentalModel useAsyncState is a small async state machine: run work, reflect pending, commit the latest result, surface the latest error.
 * @pitfall useAsyncState does not cancel the underlying async work. It only prevents stale completions from mutating hook state.
 * @pitfall Keep action pure with respect to state transitions. Side effects that should run on success can happen after awaiting run(...).
 * @example
 * const [profile, saveProfile, meta] = useAsyncState(initialProfile, async (current, draft) => {
 *   const saved = await saveProfileToServer(draft);
 *   return { ...current, ...saved };
 * });
 *
 * await saveProfile(draft);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {any | (() => any)} initialState
 * @param {(state: any, ...args: any[]) => any | Promise<any>} action
 * @returns {[any, (...args: any[]) => Promise<any>, { pending: boolean, error: unknown | null, reset: () => void }]}
 */
function useAsyncState(host, initialState, action) {
  return useAsyncStateImpl(
    host,
    initialState,
    action,
    useState,
    useTransition,
    useRef
  );
}

/**
 * Apply an optimistic overlay on top of authoritative state.
 * Think of useOptimistic as the native Lit<sup>sx</sup> primitive for showing temporary optimistic UI while authoritative state catches up.
 * @usage Use useOptimistic when the UI should immediately reflect an expected outcome before the authoritative state changes.
 * @usage Pass an update function when optimistic inputs should be reduced over the current state instead of simply replacing it.
 * @usage Call resetOptimistic() when the optimistic overlay should be discarded explicitly, such as after a failed mutation or a retry.
 * @behavior The first argument is always the authoritative base state.
 * @behavior addOptimistic(...) queues optimistic inputs and recomputes the overlay by replaying them over the current base state.
 * @behavior If the base state changes by Object.is, the optimistic queue is cleared and the hook re-anchors to the new base state.
 * @mentalModel useOptimistic layers temporary expectations over real state. The base stays authoritative; the overlay stays disposable.
 * @pitfall useOptimistic does not persist the optimistic queue across authoritative state changes.
 * @pitfall Keep updateFn deterministic. The optimistic overlay is recomputed by replaying queued inputs during render.
 * @example
 * const [optimisticTodos, addTodoOptimistic, resetOptimisticTodos] = useOptimistic(
 *   todos,
 *   (currentTodos, optimisticTodo) => [...currentTodos, optimisticTodo]
 * );
 *
 * addTodoOptimistic({ id: "temp-1", title: draftTitle });
 * @param {import('lit').ReactiveControllerHost} host
 * @param {any} state
 * @param {(state: any, optimisticValue: any) => any} [updateFn]
 * @returns {[any, (value: any) => void, () => void]}
 */
function useOptimistic(host, state, updateFn) {
  return useOptimisticImpl(host, state, updateFn, useRef, useState);
}

/**
 * Schedule non-urgent updates and track whether they are pending.
 * Think of useTransition as a way to split an interaction into urgent work now and heavier work that can follow without blocking responsiveness.
 * @usage Use useTransition when a UI interaction should stay responsive while heavier follow-up work completes in the background.
 * @usage The returned boolean tells you whether the transition is still pending so the component can reflect that in the UI.
 * @usage Keep urgent state updates outside the transition and move only the expensive follow-up work into the transition callback.
 * @behavior The returned start function schedules work through the host transition machinery.
 * @behavior The pending flag stays true while transition work is still unresolved.
 * @behavior Transitions are host-scoped. A pending transition only reflects non-urgent work scheduled for the current component host.
 * @mentalModel A transition is not a different kind of state. It is a different priority for updating the UI.
 * @pitfall Do not wrap every update in a transition. Use it when keeping input or interaction responsiveness matters more than reflecting every expensive change immediately.
 * @pitfall The pending flag only tells you about transition work started by the current host, not about the whole application.
 * @example
 * const [isPending, startTransition] = useTransition();
 * startTransition(() => {
 *   setSearchQuery(nextQuery);
 * });
 * @param {import('lit').ReactiveControllerHost} host
 * @returns {[boolean, (callback: () => any) => any]} A pending flag and a function that schedules non-urgent work.
 */
function useTransition(host) {
  return useTransitionImpl(host);
}

/**
 * Schedule non-urgent updates using the same transition machinery as useTransition.
 * @param {import('lit').ReactiveControllerHost} host
 * @param {() => any} callback
 * @returns {any}
 */
function startTransition(host, callback) {
  return startTransitionImpl(host, callback);
}

/**
 * Let expensive consumers lag behind a fast-changing value.
 * Think of useDeferredValue as a way to let expensive consumers lag behind a fast-changing value without freezing the rest of the interaction.
 * @usage Use useDeferredValue when a derived subtree is expensive and should lag slightly behind more urgent updates.
 * @usage This is useful for search results, filtered lists, and other views that are expensive to recompute on every keystroke.
 * @usage Use the deferred value downstream, not upstream. Read urgent input state directly and pass the deferred value into expensive calculations.
 * @behavior Lit<sup>sx</sup> may keep returning an older value temporarily while the deferred update is still pending.
 * @behavior This helps expensive UI stay responsive without blocking urgent interactions.
 * @behavior useDeferredValue does not debounce updates. Every value still flows through; Lit<sup>sx</sup> simply lets expensive consumers lag behind.
 * @mentalModel The source value changes immediately, but expensive readers can temporarily stay on the previous value until the deferred update catches up.
 * @pitfall useDeferredValue does not reduce the number of updates. It changes when expensive consumers observe them.
 * @pitfall Keep reading the urgent source directly where immediacy matters, and only pass the deferred value into slower subtrees or calculations.
 * @example
 * const deferredQuery = useDeferredValue(searchQuery);
 * const results = useMemoValue(() => search(items, deferredQuery), [items, deferredQuery]);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {any} value Value that may change more frequently than the UI should immediately reflect.
 * @param {{ timeout?: number }} [options] Optional timing hints for how long the deferred value may lag behind.
 * @returns {any} The deferred value currently exposed to render logic.
 */
function useDeferredValue(host, value, options) {
  return useDeferredValueImpl(host, value, options);
}

/**
 * Store a mutable value across renders without causing updates.
 * @usage Use useRef for stable mutable cells such as timers, previous snapshots, and imperative handles.
 * @usage Attach a ref created by useRef to JSX `ref=...` when it should point at a rendered element or component instance.
 * @behavior The ref object exposes a mutable current property.
 * @behavior When attached to an intrinsic element, the Lit<sup>sx</sup> transform layer keeps current synchronized with that rendered element.
 * @behavior When attached to a component tag, the ref resolves to the component instance by default.
 * @behavior Components can override that default target by explicitly forwarding the incoming ref to another element or child component.
 * @behavior When used as plain mutable storage, the ref persists across renders without causing updates on writes.
 * @mentalModel useRef is the single mutable ref primitive in Lit<sup>sx</sup>, whether the ref stores arbitrary data, tracks a rendered DOM node, or points at a component instance.
 * @pitfall Do not read ref.current as a source of truth for render decisions if that value can change outside the current render pass.
 * @pitfall Prefer state hooks when a change should trigger an update. Refs are for persistence and imperative coordination.
 * @example
 * const inputRef = useRef(null);
 *
 * useOnCommit(() => {
 *   inputRef.current?.focus();
 * }, []);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {any} [initialValue]
 */
function useRef(host, initialValue) {
  return useRefImpl(host, initialValue);
}

/**
 * Generate a stable id for the current component instance.
 * Note: this currently guarantees client-side stability only. SSR/hydration
 * compatibility will require a deterministic prefixing strategy shared across
 * server and client renders.
 * @usage Use useId when a component needs a unique per-instance id for authored DOM relationships such as `for`, `aria-labelledby`, or `aria-describedby`.
 * @usage Prefer useStableId when identity should follow one authored hook callsite across SSR and hydration, and useHostTypeId when identity should follow the component type itself.
 * @behavior Returns one stable id for the lifetime of the current host instance.
 * @behavior Different instances of the same component receive different values.
 * @mentalModel useId gives each mounted component instance its own local id namespace for DOM wiring.
 * @pitfall Do not use this for cache keys, preload identity, or SSR-stable structural resources. Its contract is instance-scoped, not callsite-scoped.
 * @example
 * const inputId = useId();
 *
 * return (
 *   <>
 *     <label for={inputId}>Email</label>
 *     <input id={inputId} type="email" />
 *   </>
 * );
 * @param {import('lit').ReactiveControllerHost} host
 * @returns {string}
 */
function useId(host) {
  return useIdImpl(host);
}

/**
 * Return a stable identifier for the authored callsite.
 * LitSX tooling injects callsite metadata so the returned value is stable across
 * SSR and client hydration and does not depend on render order or instance
 * order. Use this for callsite-scoped resource/preload identity, not for unique
 * DOM ids. When cache identity should follow the component definition, prefer
 * useHostTypeId().
 * @param {import('lit').ReactiveControllerHost} host
 * @param {string} [callsiteId]
 * @returns {string}
 */
function useStableId(host, callsiteId) {
  return useStableIdImpl(host, callsiteId);
}

/**
 * Run a callback ref through the component lifecycle.
 * @param {import('lit').ReactiveControllerHost} host
 * @param {() => Element | null} getTarget
 * @param {(node: Element | null) => void} callback
 * @param {ReadonlyArray<unknown>} [deps]
 */
function useCallbackRef(host, getTarget, callback, deps) {
  return useCallbackRefImpl(host, getTarget, callback, deps);
}

/**
 * Publish a small imperative method surface either on the host instance or through a forwarded ref.
 * Think of useExpose as the place where a component declares the public commands it supports.
 * @usage Use useExpose when a component should publish imperative methods such as focus(), open(), reset(), or reportValidity().
 * @usage Keep the exposed surface method-only. Read/write properties such as value, name, disabled, or readonly state such as validity belong on the normal host API.
 * @usage Call useExpose(createHandle, deps) to install those methods on the current component instance.
 * @usage Call useExpose(ref, createHandle, deps) when a wrapper or forwarded-ref component should expose methods through an explicit ref channel instead of the local host instance.
 * @behavior The host-targeted signature installs the returned methods on the host instance itself.
 * @behavior The ref-targeted signature assigns the returned method surface to the provided ref during the host lifecycle and clears that ref on disconnect.
 * @behavior Recompute the exposed method implementations only when one of the listed dependencies changes.
 * @behavior When several useExpose calls publish the same method on the same target, the last publisher wins until it disappears.
 * @mentalModel useExpose draws a boundary between the component's full internal implementation and the few imperative commands it chooses to make public.
 * @pitfall useExpose only supports methods. Expose properties through the normal component surface instead of returning them here.
 * @pitfall Keep the public command surface narrow and intention-revealing. A small set of named commands is easier to maintain than a grab-bag of internals.
 * @example
 * useExpose(() => ({
 *   focus() {
 *     inputRef.current?.focus();
 *   },
 *   clear() {
 *     setValue("");
 *   },
 * }), [inputRef, setValue]);
 *
 * useExpose(forwardedRef, () => ({
 *   focus() {
 *     innerRef.current?.focus();
 *   },
 * }), [forwardedRef, innerRef]);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {{ current: Record<string, Function> | null } | ((value: Record<string, Function> | null) => void) | (() => Record<string, Function>)} refOrCreateHandle
 * Either the target ref that should receive the exposed methods, or the handle factory when targeting the host instance directly.
 * @param {(() => Record<string, Function>) | ReadonlyArray<unknown>} [createHandleOrDeps]
 * Handle factory for the ref-targeted signature, or dependency list for the host-targeted signature.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that control when the exposed method implementations should be refreshed.
 */
function useExpose(host, refOrCreateHandle, createHandleOrDeps, deps) {
  return useExposeImpl(host, refOrCreateHandle, createHandleOrDeps, deps);
}

/**
 * Subscribe to external state and read its current snapshot.
 * Think of useExternalStore as the bridge between Lit<sup>sx</sup> render logic and state that already lives somewhere else.
 * @usage Use useExternalStore when state is owned outside the component tree and the host should re-render when that store changes.
 * @usage Prefer this over ad-hoc subscriptions when you want a consistent render-time snapshot model.
 * @usage Keep getSnapshot cheap and synchronous, because Lit<sup>sx</sup> calls it during render to decide what the component should show.
 * @usage Reach for useExternalStore when the source of truth already lives outside Lit<sup>sx</sup>, such as a shared store, browser API, or external cache.
 * @behavior Lit<sup>sx</sup> subscribes during the host lifecycle and requests updates when the snapshot changes.
 * @behavior The value returned during render is always the latest snapshot from getSnapshot().
 * @behavior subscribe should register the listener and return an unsubscribe function. Avoid performing asynchronous reads inside getSnapshot.
 * @behavior A store update only affects hosts that currently subscribe to that store through useExternalStore.
 * @mentalModel The external store remains the source of truth. Lit<sup>sx</sup> only asks for the current snapshot and schedules a render when that snapshot changes.
 * @pitfall Keep getSnapshot synchronous and cheap. If it performs asynchronous work or expensive derivations, render performance will suffer.
 * @pitfall Avoid shaping the store contract around a single component. Stable store APIs are easier to reuse across several hosts.
 * @example
 * const online = useExternalStore(
 *   subscribeToConnectivity,
 *   getConnectivitySnapshot
 * );
 * @param {import('lit').ReactiveControllerHost} host
 * @param {(listener: () => void) => () => void} subscribe Function that subscribes a listener and returns an unsubscribe function.
 * @param {() => any} getSnapshot Function that returns the current store snapshot during render.
 * @param {() => any} [getServerSnapshot] Optional snapshot getter for server rendering scenarios.
 * @returns {any} The latest snapshot currently exposed by the external store.
 */
function useExternalStore(host, subscribe, getSnapshot, getServerSnapshot) {
  return useExternalStoreImpl(host, subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Return the current component instance.
 * Use this when a component or custom hook needs direct access to instance-level platform APIs.
 * @usage Call useHost inside a Lit<sup>sx</sup> component or custom hook during render.
 * @usage Prefer more specific hooks like useRef when you need a rendered DOM node instead of the host instance itself.
 * @behavior Returns the active component instance for the current render pass.
 * @behavior Throws if called without an active host, just like other Lit<sup>sx</sup> hooks.
 * @mentalModel useHost gives authored code access to the current component instance as host-level platform context, not as render data.
 * @pitfall Prefer more specific hooks like useRef, useHostContent, or useSlot when they describe the intent more clearly than direct host access.
 * @pitfall Do not turn useHost into the default path for every DOM interaction. Reach for it when the component genuinely needs host-level platform APIs.
 * @example
 * const host = useHost();
 *
 * useOnConnect(() => {
 *   const observer = new MutationObserver(() => {
 *     console.log(host.textContent);
 *   });
 *   observer.observe(host, { childList: true, subtree: true });
 *   return () => observer.disconnect();
 * }, []);
 * @param {import('lit').ReactiveControllerHost} host
 * @returns {import('lit').ReactiveControllerHost}
 */
function useHost(host) {
  const resolvedHost = resolveRuntimeHost(host);
  if (!resolvedHost) {
    throw new TypeError(
      "Lit<sup>sx</sup> hooks require an active ReactiveControllerHost during render."
    );
  }
  return resolvedHost;
}

/**
 * Return the stable LitSX host-type identity for the current component definition.
 * Use this when resource identity should follow the authored component type rather than the current host instance or an individual hook callsite.
 * @usage Call useHostTypeId inside a Lit<sup>sx</sup> component or custom hook during render when caches, SSR records, or hydration metadata must be keyed to the component type.
 * @usage Prefer useStableId when identity should follow one authored hook callsite, and useId when identity should be unique per host instance.
 * @behavior Returns the same value for every instance of the same Lit<sup>sx</sup>-compiled component type.
 * @behavior Throws when the current host does not expose Lit<sup>sx</sup> host-type metadata, because a weak fallback would break SSR/cache semantics.
 * @mentalModel useHostTypeId reads the stable identity of the component definition currently rendering, not the identity of this specific mounted element.
 * @pitfall Do not use this for unique DOM ids. All instances of the same component type intentionally share the same value.
 * @example
 * const hostTypeId = useHostTypeId();
 * const resourceKey = `${hostTypeId}:${locale}`;
 * @param {import('lit').ReactiveControllerHost} host
 * @returns {string}
 */
function useHostTypeId(host) {
  const resolvedHost = useHost(host);
  const hostTypeId = resolvedHost?.constructor?.[LITSX_HOST_TYPE_ID];

  if (typeof hostTypeId === "string" && hostTypeId.length > 0) {
    return hostTypeId;
  }

  throw new TypeError(
    "useHostTypeId requires a LitSX-compiled component host with stable host-type metadata."
  );
}

/**
 * Read reactive light DOM content from the current component.
 * Use this when authored code needs projected text or nodes as input, while staying aligned with the web-component model.
 * @usage Call useHostContent when a component derives behavior from the content placed inside its own tag.
 * @usage Prefer this over manual MutationObserver wiring when the goal is to react to host content changes declaratively.
 * @usage Use the returned `text` for textual inputs, `nodes` for generic projected content, and `slots` when content should be grouped by slot name.
 * @behavior Returns a reactive snapshot of the current host content.
 * @behavior The snapshot updates when light DOM children, text nodes, or slot attributes change.
 * @behavior `slots.default` contains nodes without an explicit slot name.
 * @mentalModel useHostContent treats the host's light DOM as input data owned by the component boundary, not as an implementation detail hidden behind `this.textContent`.
 * @pitfall This reads projected host content, not `children` as an abstract virtual data structure or general-purpose render value.
 * @example
 * const content = useHostContent({ trim: true });
 * const source = content.text;
 *
 * return <pre>{source}</pre>;
 * @param {import('lit').ReactiveControllerHost} host
 * @param {{ trim?: boolean }} [options]
 * @returns {{ text: string, nodes: Node[], hasContent: boolean, slots: Record<string, Node[]> & { default: Node[] } }}
 */
function useHostContent(host, options) {
  let runtimeHost = host;
  let normalizedOptions = options;

  if (!isReactiveControllerHostLike(host)) {
    runtimeHost = undefined;
    normalizedOptions = host;
  }

  const resolvedHost = useHost(runtimeHost);
  normalizedOptions = normalizedOptions && typeof normalizedOptions === "object"
    ? normalizedOptions
    : {};
  const [snapshot, setSnapshot] = useState(
    resolvedHost,
    () => createHostContentSnapshot(resolvedHost, normalizedOptions)
  );

  useOnConnect(resolvedHost, () => {
    if (typeof MutationObserver !== "function") {
      return;
    }

    const syncSnapshot = () => {
      const nextSnapshot = createHostContentSnapshot(resolvedHost, normalizedOptions);
      setSnapshot((prevSnapshot) =>
        isSameHostContentSnapshot(prevSnapshot, nextSnapshot)
          ? prevSnapshot
          : nextSnapshot
      );
    };

    const observer = new MutationObserver(() => {
      syncSnapshot();
    });

    observer.observe(resolvedHost, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["slot"],
    });

    syncSnapshot();

    return () => {
      observer.disconnect();
    };
  }, [normalizedOptions.trim]);

  return snapshot;
}

/**
 * Read reactive text content projected into the current component.
 * Use this when the component consumes light DOM text as input data.
 * @usage Call useTextContent when content inside the host should be treated as text, such as markdown, SQL, or authored source code.
 * @usage Prefer useHostContent when the component also needs direct access to projected nodes or slot groupings.
 * @behavior Returns a reactive text snapshot derived from the current host content.
 * @behavior The returned string updates when host text nodes or child content change.
 * @mentalModel useTextContent treats the host's projected content as a text input stream for the component, not as node-level structure.
 * @pitfall useTextContent flattens projected content to text. If the component cares about node boundaries or named slots, useHostContent or useSlot instead.
 * @pitfall Text snapshots may include formatting whitespace from authored markup unless `trim` is enabled or the caller normalizes the content.
 * @example
 * const source = useTextContent({ trim: true });
 * @param {import('lit').ReactiveControllerHost} host
 * @param {{ trim?: boolean }} [options]
 * @returns {string}
 */
function useTextContent(host, options) {
  let runtimeHost = host;
  let normalizedOptions = options;

  if (!isReactiveControllerHostLike(host)) {
    runtimeHost = undefined;
    normalizedOptions = host;
  }

  return runtimeHost === undefined
    ? useHostContent(normalizedOptions).text
    : useHostContent(runtimeHost, normalizedOptions).text;
}

/**
 * Read reactive projected nodes for one slot.
 * Use this when authored code needs projected content grouped by slot name in a web-component-native way.
 * @usage Call useSlot() for default content and useSlot("name") for named projected content.
 * @usage Prefer useHostContent when the component needs the full host-content snapshot instead of just one slot.
 * @behavior Returns a reactive array of nodes assigned to the requested slot.
 * @behavior The returned array updates when projected nodes are added, removed, or moved between slots.
 * @mentalModel useSlot gives authored code a reactive view of projected light DOM for one slot. It does not render, clone, or virtualize children as framework-level data.
 * @pitfall useSlot reads host-projected content, not JSX `children` as a manipulable abstract data structure.
 * @example
 * const defaultNodes = useSlot();
 * const actions = useSlot("actions");
 * @param {import('lit').ReactiveControllerHost} host
 * @param {string} [slotName]
 * @returns {Node[]}
 */
function useSlot(host, slotName) {
  let runtimeHost = host;
  let requestedSlot = slotName;

  if (!isReactiveControllerHostLike(host)) {
    runtimeHost = undefined;
    requestedSlot = host;
  }

  const resolvedSlotName = typeof requestedSlot === "string" && requestedSlot
    ? requestedSlot
    : "default";

  return useHostContent(runtimeHost).slots[resolvedSlotName] ?? [];
}

/**
 * Apply a dynamic style property to the current component host.
 * Think of useStyle as the authored way to drive CSS custom properties or individual host style values from component state.
 * @usage Use useStyle for dynamic theme values, layout measurements, or other single style properties that change with state.
 * @usage This is especially useful for CSS custom properties such as `--accent-color` that your stylesheet consumes.
 * @usage Prefer useStyle over rebuilding a full stylesheet string when only one or two host-level style values are dynamic.
 * @usage Pass a compute function when the style value should be derived after commit. Add a dependency array only when that derived value should be recalculated for specific reactive inputs instead of every commit.
 * @behavior Lit<sup>sx</sup> applies the style property to the host element after commit.
 * @behavior Passing `null`, `undefined`, or `false` removes the property from the host.
 * @behavior The property is applied through the host's inline style object, making it a good fit for CSS variables and host-level overrides.
 * @mentalModel useStyle lets JavaScript decide a value while CSS keeps ownership of how that value is consumed.
 * @pitfall Do not use useStyle to move large amounts of visual styling into JavaScript. Keep most presentation in CSS rules and use this hook only for the dynamic edge.
 * @pitfall When the value naturally belongs on a child element rather than the host, prefer a normal JSX `style` binding or a class/attribute-based selector.
 * @pitfall Keep compute functions pure. Omitting the dependency array means the compute function runs after every commit.
 * @example
 * useStyle("--accent-color", accent);
 * useStyle("--panel-width", `${width}px`);
 * useStyle("--panel-gap", () => `${gap}px`);
 * useStyle("--panel-gap", () => `${gap}px`, [gap]);
 * @param {import('lit').ReactiveControllerHost} host
 * @param {string} propertyName CSS property name to set on the current host.
 * @param {string | number | null | undefined | false | (() => string | number | null | undefined | false)} valueOrFactory Value to assign to that property, or a pure compute function evaluated after commit.
 * @param {ReadonlyArray<unknown>} [deps] Reactive values that control when the computed style value should be recalculated.
 */
function useStyle(host, propertyName, valueOrFactory, deps) {
  const isComputed = typeof valueOrFactory === "function";

  useOnCommit(host, () => {
    if (!host?.style) return;

    const value = isComputed ? valueOrFactory() : valueOrFactory;

    if (value == null || value === false) {
      host.style.removeProperty?.(propertyName);
      return;
    }

    host.style.setProperty?.(propertyName, String(value));
  }, isComputed
    ? (Array.isArray(deps) ? [propertyName, ...deps] : undefined)
    : [propertyName, valueOrFactory]);
}

function normalizeClientImports(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.filter((entry) => typeof entry === "string" && entry.length > 0))];
}

/**
 * Default JSON script id used for client import metadata emitted by `@litsx/ssr`.
 */
const LITSX_CLIENT_IMPORTS_SCRIPT_ID = "__LITSX_CLIENT_IMPORTS__";

/**
 * Default JSON script id used for LitSX hydration metadata emitted by `@litsx/ssr`.
 */
const LITSX_HYDRATION_DATA_SCRIPT_ID = "__LITSX_HYDRATION__";

/**
 * Root host attribute used to correlate DOM elements with LitSX SSR root ids.
 */
const LITSX_ROOT_ATTRIBUTE = "data-litsx-root";

/**
 * Comment-marker prefix used as a fallback when no explicit root attribute exists.
 */
const LITSX_ROOT_MARKER_PREFIX = "litsx-root";

/**
 * Property used to attach the resolved root-scoped hydration payload to a host.
 */
const LITSX_HYDRATION_PAYLOAD_PROPERTY = "__litsxHydrationPayload";

async function importClientModule(specifier) {
  return import(/* @vite-ignore */ specifier);
}

function getCustomElementRegistry() {
  return globalThis.customElements ?? null;
}

function isRegistrableHydrationExport(value) {
  return isHydratableCustomElementClass(value);
}

function registerHydratableElement(ctor) {
  if (!isCustomElementClass(ctor)) {
    throw new TypeError("Hydration registration requires a custom element constructor.");
  }

  const tagName = ctor[LITSX_HYDRATABLE_TAG];
  const registry = getCustomElementRegistry();

  if (!registry) {
    throw new Error(
      `Cannot register LitSX hydration element "${tagName}" because globalThis.customElements is not available.`
    );
  }

  const existing = registry.get?.(tagName) ?? null;
  if (existing === ctor) {
    return;
  }

  if (existing && existing !== ctor) {
    throw new Error(
      `Cannot register LitSX hydration element "${tagName}" with a different constructor.`
    );
  }

  registry.define(tagName, ctor);
}

function collectHydratableModuleExports(moduleNamespace) {
  if (!moduleNamespace || typeof moduleNamespace !== "object") {
    return [];
  }

  const seen = new Set();
  const matches = [];
  for (const value of Object.values(moduleNamespace)) {
    if (!isRegistrableHydrationExport(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    matches.push(value);
  }
  return matches;
}

function resolveDocument(rootOrDocument) {
  if (!rootOrDocument) {
    return typeof document === "undefined" ? null : document;
  }

  if (typeof rootOrDocument.getElementById === "function") {
    return rootOrDocument;
  }

  return rootOrDocument.ownerDocument ?? null;
}

function readScriptText(documentRef, id) {
  if (!documentRef || !id || typeof documentRef.getElementById !== "function") {
    return null;
  }

  const node = documentRef.getElementById(id);
  return typeof node?.textContent === "string" ? node.textContent : null;
}

function parseJsonScript(documentRef, id) {
  const text = readScriptText(documentRef, id);
  if (text == null || text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse LitSX SSR JSON script "${id}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeHydrationRoots(value) {
  if (!value || !Array.isArray(value.roots)) {
    return [];
  }

  return value.roots.filter((root) =>
    root &&
    typeof root === "object" &&
    typeof root.id === "string" &&
    root.id.length > 0,
  );
}

function normalizeHydrationPayload(value) {
  const payload = value?.payload;
  if (payload == null) {
    return {
      roots: {},
      instances: {},
    };
  }

  if (
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.roots == null ||
    payload.instances == null ||
    typeof payload.roots !== "object" ||
    Array.isArray(payload.roots) ||
    typeof payload.instances !== "object" ||
    Array.isArray(payload.instances)
  ) {
    throw new Error("Invalid LitSX SSR hydration payload.");
  }

  return payload;
}

function parseRootMarker(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith(LITSX_ROOT_MARKER_PREFIX)) {
    return null;
  }

  const entries = Object.fromEntries(
    text
      .slice(LITSX_ROOT_MARKER_PREFIX.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        return separatorIndex === -1
          ? [part, ""]
          : [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)];
      }),
  );

  return entries.id
    ? {
      id: entries.id,
      tagName: entries.tag ?? null,
    }
    : null;
}

function getChildNodes(container) {
  if (!container) {
    return [];
  }

  return container.childNodes ? [...container.childNodes] : [];
}

function isCommentNode(node) {
  return node?.nodeType === 8 || node?.constructor?.name === "Comment";
}

function isElementNode(node) {
  return node?.nodeType === 1 || typeof node?.tagName === "string";
}

function findNextElementSibling(node) {
  let current = node?.nextSibling ?? null;
  while (current) {
    if (isElementNode(current)) {
      return current;
    }
    current = current.nextSibling ?? null;
  }

  return null;
}

function findHydrationRootIdForElement(element) {
  if (!element) {
    return null;
  }

  const attributeRootId = element.getAttribute?.(LITSX_ROOT_ATTRIBUTE);
  if (attributeRootId) {
    return attributeRootId;
  }

  let current = element.previousSibling ?? null;
  while (current) {
    if (isElementNode(current)) {
      return null;
    }

    if (isCommentNode(current)) {
      const marker = parseRootMarker(current.data ?? current.nodeValue);
      return marker?.id ?? null;
    }

    current = current.previousSibling ?? null;
  }

  return null;
}

function walkNodes(container, visit) {
  for (const node of getChildNodes(container)) {
    if (visit(node) === false) {
      return false;
    }

    if (node?.childNodes && walkNodes(node, visit) === false) {
      return false;
    }

    if (node?.shadowRoot && walkNodes(node.shadowRoot, visit) === false) {
      return false;
    }
  }
  return true;
}

function queryHydrationRoot(container, id) {
  if (!container || !id) {
    return null;
  }

  let match = null;
  walkNodes(container, (node) => {
    if (isElementNode(node) && node.getAttribute?.(LITSX_ROOT_ATTRIBUTE) === id) {
      match = node;
      return false;
    }

    if (!isCommentNode(node)) {
      return true;
    }

    const marker = parseRootMarker(node.data ?? node.nodeValue);
    if (marker?.id !== id) {
      return true;
    }

    match = findNextElementSibling(node);
    return false;
  });

  return match;
}

function readClientImports(
  rootOrDocument = typeof document === "undefined" ? null : document,
  options = {},
) {
  const explicit = options.clientImports ?? options.imports;
  if (explicit != null) {
    return normalizeClientImports(explicit);
  }

  const documentRef = resolveDocument(rootOrDocument);
  const scriptId = options.scriptId ?? LITSX_CLIENT_IMPORTS_SCRIPT_ID;
  const parsed = parseJsonScript(documentRef, scriptId);
  const imports = normalizeClientImports(parsed);
  if (imports.length > 0) {
    return imports;
  }

  const hydrationData = readHydrationData(rootOrDocument, {
    hydrationData: options.hydrationData,
  });
  return normalizeClientImports(hydrationData?.clientImports);
}

function readHydrationData(
  rootOrDocument = typeof document === "undefined" ? null : document,
  options = {},
) {
  const explicit = options.hydrationData;
  if (explicit != null) {
    return explicit;
  }

  const documentRef = resolveDocument(rootOrDocument);
  const scriptId = options.scriptId ?? LITSX_HYDRATION_DATA_SCRIPT_ID;
  return parseJsonScript(documentRef, scriptId);
}

function readHydrationPayload(
  rootOrDocument = typeof document === "undefined" ? null : document,
  options = {},
) {
  return normalizeHydrationPayload(readHydrationData(rootOrDocument, options));
}

function resolveHydrationRoots(
  rootOrDocument = typeof document === "undefined" ? null : document,
  options = {},
) {
  const hydrationData = readHydrationData(rootOrDocument, options);
  const roots = normalizeHydrationRoots(hydrationData);

  return roots.map((root) => {
    const element = queryHydrationRoot(rootOrDocument, root.id);
      if (!element) {
        throw new Error(
          `Failed to find a LitSX hydration root element for "${root.id}".`
        );
      }

    const actualTagName = typeof element.tagName === "string"
      ? element.tagName.toLowerCase()
      : null;
    if (root.tagName && actualTagName && actualTagName !== String(root.tagName).toLowerCase()) {
      throw new Error(
        `Hydration root "${root.id}" expected <${root.tagName}> but found <${actualTagName}>.`
      );
    }

    return {
      ...root,
      element,
    };
  });
}

function applyHydrationPayload(
  roots,
  hydrationData,
) {
  const payload = normalizeHydrationPayload(hydrationData);

  for (const root of roots) {
    const rootPayload = payload.roots[root.id] ?? null;
    if (rootPayload == null) {
      continue;
    }

    const currentPayload = root.element[LITSX_HYDRATION_PAYLOAD_PROPERTY];
    if (currentPayload !== undefined && currentPayload !== rootPayload) {
      throw new Error(`Hydration payload for root "${root.id}" has already been applied.`);
    }

    root.element[LITSX_HYDRATION_PAYLOAD_PROPERTY] = rootPayload;
    if (
      rootPayload.props &&
      typeof rootPayload.props === "object" &&
      !Array.isArray(rootPayload.props)
    ) {
      Object.assign(root.element, rootPayload.props);
    }
  }

  return roots;
}

/**
 * Resolve a single LitSX hydration root by id from the current SSR metadata.
 */
function resolveHydrationRoot(
  rootOrDocument = typeof document === "undefined" ? null : document,
  rootId,
  options = {},
) {
  if (typeof rootId !== "string" || rootId.length === 0) {
    throw new TypeError("resolveHydrationRoot(...) requires a non-empty root id.");
  }

  const roots = resolveHydrationRoots(rootOrDocument, options);
  const match = roots.find((entry) => entry.id === rootId);
  if (!match) {
    throw new Error(`Hydration metadata did not include root "${rootId}".`);
  }

  return match;
}

/**
 * Register every hydratable LitSX custom element exported by a module namespace.
 *
 * This only inspects module exports and the global custom element registry.
 * It does not touch the DOM, read hydration payloads, or trigger hydration.
 */
function registerHydrationModule(moduleNamespace) {
  for (const ctor of collectHydratableModuleExports(moduleNamespace)) {
    registerHydratableElement(ctor);
  }
}

/**
 * Resolve module namespaces or async module loaders, then register every
 * hydratable LitSX custom element they export.
 */
async function registerHydrationModules(modules) {
  const entries = Array.isArray(modules) ? modules : [];
  for (const entry of entries) {
    const moduleNamespace = typeof entry === "function" ? await entry() : entry;
    registerHydrationModule(moduleNamespace);
  }
}

/**
 * Read SSR hydration metadata, run optional root-registration bootstrap code,
 * and then load the client-side modules needed to upgrade SSR-rendered LitSX
 * roots.
 *
 * This helper intentionally stays minimal:
 * - it does not walk the DOM or generate hydration payloads
 * - it relies on the top-level hydration support installed by this module
 * - it leaves root custom-element registration to the caller's bootstrap code
 *
 * Typical usage:
 *
 * `await hydrate(document, { register: () => import("./main.js"), clientImports });`
 */
async function hydrate(
  root = typeof document === "undefined" ? null : document,
  options = {},
) {
  const {
    register,
    moduleLoader = importClientModule,
  } = options;

  const hydrationData = readHydrationData(root, options);
  const hydrationRoots = resolveHydrationRoots(root, options);
  applyHydrationPayload(hydrationRoots, hydrationData);

  if (typeof register === "function") {
    await register();
  }

  const specifiers = readClientImports(root, options);
  const modules = await Promise.all(specifiers.map((specifier) => moduleLoader(specifier)));
  modules.forEach((moduleNamespace) => {
    if (getCustomElementRegistry() && moduleNamespace && typeof moduleNamespace === "object") {
      registerHydrationModule(moduleNamespace);
    }
  });

  return hydrationRoots.length > 0 ? hydrationRoots : root;
}

async function hydrateRoot(
  root,
  options = {},
) {
  const {
    register,
    moduleLoader = importClientModule,
  } = options;
  const element = root?.host ?? root;
  const rootId = options.rootId ?? findHydrationRootIdForElement(element);

  if (!rootId) {
    throw new Error(
      "hydrateRoot(...) requires a root id or an element marked as a LitSX SSR root."
    );
  }

  const documentRef = resolveDocument(root) ?? root;
  const hydrationData = readHydrationData(documentRef, options);
  const rootMetadata = normalizeHydrationRoots(hydrationData).find((entry) => entry.id === rootId);
  if (!rootMetadata) {
    throw new Error(`Hydration metadata did not include root "${rootId}".`);
  }

  const actualTagName = typeof element?.tagName === "string"
    ? element.tagName.toLowerCase()
    : null;
  if (
    rootMetadata.tagName &&
    actualTagName &&
    actualTagName !== String(rootMetadata.tagName).toLowerCase()
  ) {
    throw new Error(
      `Hydration root "${rootId}" expected <${rootMetadata.tagName}> but found <${actualTagName}>.`
    );
  }

  const match = {
    ...rootMetadata,
    element,
  };
  applyHydrationPayload([match], hydrationData);

  if (typeof register === "function") {
    await register();
  }

  const specifiers = readClientImports(root, options);
  const modules = await Promise.all(specifiers.map((specifier) => moduleLoader(specifier)));
  modules.forEach((moduleNamespace) => {
    if (getCustomElementRegistry() && moduleNamespace && typeof moduleNamespace === "object") {
      registerHydrationModule(moduleNamespace);
    }
  });

  return match.element ?? element;
}

async function hydrateDocument(options = {}) {
  const root = options.document ?? (typeof document === "undefined" ? null : document);
  return hydrate(root, options);
}

/**
 * Hydrate a full SSR-rendered page using the default LitSX SSR document metadata.
 *
 * This is the recommended document-level entrypoint for pages rendered by
 * `renderDocument(...)`. It is equivalent to `hydrateDocument(...)` but makes
 * the whole-page intent explicit in public API docs.
 */
async function hydratePage(options = {}) {
  return hydrateDocument(options);
}

export { useStyle as $, useDeferredValue as A, useElementInternals as B, useEmit as C, useEvent as D, EffectsController as E, useExpose as F, useExternalStore as G, HostMiddlewareMixin as H, useFormValidity as I, useFormValue as J, useHost as K, LITSX_COMPONENT as L, useHostContent as M, useHostTypeId as N, useId as O, useMemoValue as P, useOnCommit as Q, useOnConnect as R, STRUCTURAL_HOOK_ENTRIES as S, useOptimistic as T, usePrevious as U, useReducedState as V, useRef as W, useSlot as X, useStableCallback as Y, useStableId as Z, useState as _, ErrorBoundary as a, useTextContent as a0, useTransition as a1, LITSX_LIGHT_DOM as a2, LITSX_MODULE_ID as a3, LITSX_SCOPED_TEMPLATE as a4, LITSX_SERVER_COMPONENT as a5, LITSX_SERVER_COMPONENT_CALL as a6, LITSX_SSR_CONTEXT as a7, LightDomMixin as a8, LitsxStaticHoistsMixin as a9, ShadowDomMixin as aa, __isLitsxScopedTemplate as ab, __isLitsxServerComponentCall as ac, __litsxScopedTemplate as ad, __litsxServerComponentCall as ae, annotateHydratableCustomElement as af, isCustomElementClass as ag, isHydratableCustomElementClass as ah, LITSX_CLIENT_IMPORTS_SCRIPT_ID as ai, LITSX_HYDRATION_DATA_SCRIPT_ID as aj, LITSX_HYDRATION_PAYLOAD_PROPERTY as ak, LITSX_ROOT_ATTRIBUTE as al, LITSX_ROOT_MARKER_PREFIX as am, applyHydrationPayload as an, hydrate as ao, hydrateDocument as ap, hydratePage as aq, hydrateRoot as ar, readClientImports as as, readHydrationData as at, readHydrationPayload as au, registerHydrationModule as av, registerHydrationModules as aw, resolveHydrationRoot as ax, resolveHydrationRoots as ay, HostMiddlewareRuntime as b, LITSX_HOOK as c, LITSX_HOST_TYPE_ID as d, LITSX_HYDRATABLE_TAG as e, SuspenseBoundary as f, SuspenseList as g, collectSoftSuspenseThenables as h, createExecutionContextKey as i, createHostMiddlewareRuntime as j, defineHook as k, ensureLazyElement as l, getCurrentExecutionContext as m, isLitsxComponentClass as n, isLitsxHook as o, isStructuralHook as p, prepareEffects as q, renderWithSoftSuspense as r, resolveStructuralEntry as s, resolveStructuralProps as t, resolveStructuralStaticEntry as u, startTransition as v, useAfterUpdate as w, useAsyncState as x, useCallbackRef as y, useControlledState as z };
//# sourceMappingURL=vendor-litsx.mjs.map
