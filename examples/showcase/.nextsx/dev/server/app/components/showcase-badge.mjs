import { useCallbackRef } from "@litsx/core";
import { LITSX_MODULE_ID } from "@litsx/core/elements";
import { LitElement, html } from "lit";
// @ts-nocheck
import "./showcase-badge.css.mjs?t=1784923300261";
import pulseDot from "./pulse-dot.svg.mjs?t=1784923300261";

/**
 * @param {{ label: string }} props
 */
export default class ShowcaseBadge extends LitElement {
  static [LITSX_MODULE_ID] = "/Users/rafabernad/Workspace/nextsx/examples/showcase/app/components/showcase-badge.litsx";
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