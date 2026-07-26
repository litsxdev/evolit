import { useCallbackRef } from '/_nextsx/shared/litsx__core.mjs';
import { LitElement, css, html } from '/_nextsx/shared/lit.mjs';
import { LitsxStaticHoistsMixin, __litsxScopedTemplate, LITSX_SERVER_COMPONENT } from '/_nextsx/shared/litsx__core__elements.mjs';
import AppShell from './components/app-shell.mjs';

const _litsx_static_styles = Symbol("litsx.static.styles");
const metadata = {
  title: "nextsx Showcase",
  description: "Standalone validation app for nextsx routing, assets, and caching"
};

/**
 * @param {{ href: string, label: string }} props
 */
class NavLink extends LitsxStaticHoistsMixin(LitElement) {
  static get styles() {
    return this.__litsxStatic(_litsx_static_styles, () => this.__litsxResolveStaticValue(css`
    a {
      color: rgba(243, 240, 232, 0.92);
      text-decoration: none;
      border-bottom: 1px solid rgba(243, 240, 232, 0.16);
      padding-bottom: 2px;
    }
  `));
  }
  static [Symbol.for("litsx.hostTypeId")] = "litsx-host-type-1pp0bj5";
  static [Symbol.for("litsx.hydratableTag")] = "nav-link";
  static [Symbol.for("litsx.component")] = true;
  static properties = {
    href: {
      type: String
    },
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
      href,
      label
    } = this;
    return html`<a href="${this.href}">${this.label}</a>`;
  }
}
/**
* @param {{ children: unknown }} props
*/
async function RootLayout(props) {
  const {
    children
  } = props;
  return __litsxScopedTemplate(html`<app-shell><nav-link slot="nav" href="/" label="Home"></nav-link><nav-link slot="nav" href="/blog/hello-world" label="Dynamic Blog"></nav-link><nav-link slot="nav" href="/library/books/field-guide" label="Prerendered Library"></nav-link><nav-link slot="nav" href="/news/launch-week" label="ISR News"></nav-link><nav-link slot="nav" href="/request-context" label="Request Context"></nav-link>${children}</app-shell>`, {
    "app-shell": AppShell,
    "nav-link": NavLink
  });
}
RootLayout[LITSX_SERVER_COMPONENT] = true;

export { RootLayout as default, metadata };
//# sourceMappingURL=layout.mjs.map
