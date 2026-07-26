import { useCallbackRef } from '/_nextsx/shared/litsx__core-BKwHhaBh.mjs';
import { LitsxStaticHoistsMixin } from '/_nextsx/shared/litsx__core__elements-gEpUokq0.mjs';
import { LitElement, css, html } from '/_nextsx/shared/lit-C-FzaC7s.mjs';

const _litsx_static_styles = Symbol("litsx.static.styles");
class PageFrame extends LitsxStaticHoistsMixin(LitElement) {
  static get styles() {
    return this.__litsxStatic(_litsx_static_styles, () => this.__litsxResolveStaticValue(css`
    :host {
      display: block;
      max-width: 760px;
    }

    .page {
      display: grid;
      gap: 18px;
    }

    .eyebrow {
      margin: 0;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 12px;
      color: rgba(243, 240, 232, 0.56);
    }

    .title {
      margin: 0;
      font-size: clamp(2.5rem, 7vw, 4.4rem);
    }

    .copy {
      margin: 0;
      line-height: 1.8;
      color: rgba(243, 240, 232, 0.76);
    }
  `));
  }
  static [Symbol.for("litsx.hostTypeId")] = "litsx-host-type-wxoobo";
  static [Symbol.for("litsx.hydratableTag")] = "page-frame";
  static [Symbol.for("litsx.component")] = true;
  static properties = {
    children: {
      type: String
    },
    eyebrow: {
      type: String
    },
    title: {
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
      eyebrow,
      title
    } = this;
    return html`<section class="page"><p class="eyebrow">${this.eyebrow}</p><h1 class="title">${this.title}</h1><div class="copy"><slot></slot></div></section>`;
  }
} // @ts-nocheck
/**
 * @param {{
 *   eyebrow: string,
 *   title: string,
 *   children?: unknown,
 * }} props
 */

export { PageFrame as default };
//# sourceMappingURL=page-frame-ayh-CziY.mjs.map
