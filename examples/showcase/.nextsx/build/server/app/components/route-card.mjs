import { useCallbackRef } from "@litsx/core";
import { LitsxStaticHoistsMixin, LITSX_MODULE_ID } from "@litsx/core/elements";
import { LitElement, css, html } from "lit";
const _litsx_static_styles = Symbol("litsx.static.styles");
export default class RouteCard extends LitsxStaticHoistsMixin(LitElement) {
  static [LITSX_MODULE_ID] = "/Users/rafabernad/Workspace/nextsx/examples/showcase/app/components/route-card.litsx";
  static get styles() {
    return this.__litsxStatic(_litsx_static_styles, () => this.__litsxResolveStaticValue(css`
    :host {
      display: block;
    }

    .card {
      display: grid;
      gap: 14px;
      padding: 24px;
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(12px);
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: baseline;
    }

    .title {
      margin: 0;
      font-size: 1.25rem;
    }

    .cache {
      font-size: 0.82rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(243, 240, 232, 0.54);
    }

    .body {
      margin: 0;
      line-height: 1.7;
      color: rgba(243, 240, 232, 0.78);
    }

    .link {
      color: #f3f0e8;
      text-decoration: none;
      width: fit-content;
      border-bottom: 1px solid rgba(243, 240, 232, 0.24);
      padding-bottom: 2px;
    }
  `));
  }
  static [Symbol.for("litsx.hostTypeId")] = "litsx-host-type-qnu38";
  static [Symbol.for("litsx.hydratableTag")] = "route-card";
  static [Symbol.for("litsx.component")] = true;
  static properties = {
    title: {
      type: String
    },
    body: {
      type: String
    },
    href: {
      type: String
    },
    cache: {
      type: String
    }
  };
  render() {
    useCallbackRef(this, () => this, node => {
      const componentRef = this.ref;
      if (typeof componentRef === "function") {
        componentRef(node);
      } else if (componentRef && typeof componentRef === "object") {
        componentRef.current = node;
      }
    }, [this.ref]);
    const {
      title,
      body,
      href,
      cache
    } = this;
    return html`<article class="card"><div class="header"><h2 class="title">${this.title}</h2><span class="cache">${this.cache}</span></div><p class="body">${this.body}</p><a href="${this.href}" class="link">Open route</a></article>`;
  }
} // @ts-nocheck
/**
 * @param {{ title: string, body: string, href: string, cache: string }} props
 */