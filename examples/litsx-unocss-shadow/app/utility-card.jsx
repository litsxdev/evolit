import { css } from "lit";

const stateClasses = {
  ready: "bg-emerald-500 text-white",
  waiting: "bg-amber-100 text-amber-950",
};

export default function UtilityCard({ state }) {
  return (
    <article
      data-state={state}
      class={`m-6 w-[18rem] rounded-xl p-5 shadow-lg data-[state=ready]:ring-2 ${stateClasses[state]}`}
    >
      Native LitSX owns these utilities inside this Shadow Root.
    </article>
  );
}

UtilityCard.styles = css`
  :host {
    display: block;
    color: var(--example-brand);
  }
`;

