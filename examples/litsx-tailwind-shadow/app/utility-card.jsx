import { css } from "lit";
import { STATE_CLASSES, STYLE_GUARD } from "./class-map.js";

const densityClasses = {
  compact: "py-2",
  roomy: "py-6",
};

export default function UtilityCard({ state, density = "roomy" }) {
  return (
    <article
      data-state={state}
      aria-expanded="true"
      class={`m-6 w-[18rem] rounded-xl px-5 shadow-lg data-[state=ready]:ring-2 aria-[expanded=true]:opacity-100 dark:text-white ${densityClasses[density]} ${STATE_CLASSES[state]}`}
    >
      Native LitSX owns these Tailwind utilities inside this Shadow Root.
    </article>
  );
}

UtilityCard.styles = [
  STYLE_GUARD,
  css`:host { display: block; color: var(--color-brand); }`,
];
