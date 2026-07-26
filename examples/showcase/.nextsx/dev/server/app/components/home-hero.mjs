import { useCallbackRef } from "@litsx/core";
import { LitsxStaticHoistsMixin, LITSX_MODULE_ID } from "@litsx/core/elements";
import { LitElement, css, html } from "lit";
const _litsx_static_styles = Symbol("litsx.static.styles");
export default class HomeHero extends LitsxStaticHoistsMixin(LitElement) {
  static [LITSX_MODULE_ID] = "/Users/rafabernad/Workspace/nextsx/examples/showcase/app/components/home-hero.litsx";
  static get styles() {
    return this.__litsxStatic(_litsx_static_styles, () => this.__litsxResolveStaticValue(css`
    :host {
      display: block;
    }

    .page {
      display: grid;
      gap: 28px;
    }

    .intro {
      display: grid;
      gap: 20px;
      max-width: 760px;
    }

    .eyebrow {
      margin: 0;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 12px;
      color: rgba(243, 240, 232, 0.56);
    }

    .title {
      margin: 0;
      font-size: clamp(3rem, 8vw, 5.6rem);
      line-height: 0.94;
    }

    .copy {
      margin: 0;
      line-height: 1.8;
      color: rgba(243, 240, 232, 0.76);
    }

    .card-grid {
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }
  `));
  }
  static [Symbol.for("litsx.hostTypeId")] = "litsx-host-type-1k6ir9d";
  static [Symbol.for("litsx.hydratableTag")] = "home-hero";
  static [Symbol.for("litsx.component")] = true;
  static properties = {
    children: {
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
    return html`<section class="page"><div class="intro"><slot name="intro"></slot></div><div class="card-grid"><slot></slot></div></section>`;
  }
} // @ts-nocheck
/**
 * @param {{ children?: unknown }} props
 */