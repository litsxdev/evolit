import { useCallbackRef } from '/_nextsx/shared/litsx__core-BKwHhaBh.mjs';
import { LitElement, html } from '/_nextsx/shared/lit-C-FzaC7s.mjs';

var pulseDot = "/_nextsx/static/app/components/pulse-dot.d16b06dc.svg";

/**
 * @param {{ label: string }} props
 */
class ShowcaseBadge extends LitElement {
  static [Symbol.for("litsx.hostTypeId")] = "litsx-host-type-4au0a4";
  static [Symbol.for("litsx.hydratableTag")] = "showcase-badge";
  static [Symbol.for("litsx.component")] = true;
  static properties = {
    label: {
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
      label
    } = this;
    return html`<span class="showcase-badge"><img src="${pulseDot}" alt=""><span>${this.label}</span></span>`;
  }
}

export { ShowcaseBadge as default };
//# sourceMappingURL=showcase-badge-DuzUKKQK.mjs.map
