import { presetWind3 } from "unocss";

export default {
  presets: [presetWind3()],
  preflights: [
    {
      layer: "theme",
      getCSS: () => ":root{--example-brand:rgb(37 99 235)}",
    },
  ],
};

