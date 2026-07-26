import { useCallbackRef } from "@litsx/core";
import { LitElement, html } from "lit";
// @ts-nocheck
import "./showcase-badge.css.mjs";
import pulseDot from "./pulse-dot.svg.mjs";

/**
 * @param {{ label: string }} props
 */
export default class ShowcaseBadge extends LitElement {
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