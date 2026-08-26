// @ts-nocheck
import { css } from "lit";

/**
 * @param {{ title: string, body: string, href: string, cache: string }} props
 */
export default function RouteCard(props) {
  const { title, body, href, cache } = props;

  return (
    <article class="card">
      <div class="header">
        <h2 class="title">{title}</h2>
        <span class="cache">{cache}</span>
      </div>
      <p class="body">{body}</p>
      <a href={href} class="link">
        Open route
      </a>
    </article>
  );
}

RouteCard.styles = css`
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
`;
