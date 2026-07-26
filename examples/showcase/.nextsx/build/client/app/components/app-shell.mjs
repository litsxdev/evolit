import { useCallbackRef } from "@litsx/core";
import { LitsxStaticHoistsMixin } from "@litsx/core/elements";
import { LitElement, css, html } from "lit";
const _litsx_static_styles = Symbol("litsx.static.styles");
export default class AppShell extends LitsxStaticHoistsMixin(LitElement) {
  static get styles() {
    return this.__litsxStatic(_litsx_static_styles, () => this.__litsxResolveStaticValue(css`
    :host {
      display: block;
      min-height: 100vh;
      padding: 40px 20px 72px;
      color: #f3f0e8;
      background:
        radial-gradient(circle at top left, rgba(215, 106, 61, 0.18), transparent 28%),
        linear-gradient(180deg, #12161d 0%, #182738 100%);
      font-family: Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif;
    }

    .shell {
      max-width: 1080px;
      margin: 0 auto;
    }

    .header {
      display: grid;
      gap: 18px;
      margin-bottom: 40px;
    }

    .eyebrow {
      display: inline-block;
      padding: 8px 12px;
      border: 1px solid rgba(243, 240, 232, 0.18);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 12px;
    }

    .nav {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      font-size: 0.98rem;
    }
  `));
  }
  static [Symbol.for("litsx.hostTypeId")] = "litsx-host-type-ut0zz";
  static [Symbol.for("litsx.hydratableTag")] = "app-shell";
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
    return html`<main class="shell"><header class="header"><div class="eyebrow">nextsx showcase</div><nav class="nav"><slot name="nav"></slot></nav></header><slot></slot></main>`;
  }
} // @ts-nocheck
/**
 * @param {{ children?: unknown }} props
 */