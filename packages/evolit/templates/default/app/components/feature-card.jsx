import { css } from "lit";

export default function FeatureCard({ title, body }) {
  return (
    <article class="card">
      <h2 class="title">{title}</h2>
      <p class="body">
        {body}
      </p>
    </article>
  );
}

FeatureCard.styles = css`
  :host {
    display: block;
  }

  .card {
    padding: 24px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(12px);
  }

  .title {
    margin: 0 0 12px;
    font-size: 1.25rem;
  }

  .body {
    margin: 0;
    line-height: 1.7;
    color: rgba(248, 247, 241, 0.78);
  }
`;
