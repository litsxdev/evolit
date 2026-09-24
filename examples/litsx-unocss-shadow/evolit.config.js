import { litsxUnoCss } from "@litsx/unocss";
import { defineEvolitConfig } from "evolit/litsx";

export default defineEvolitConfig({
  litsx: {
    compiler: {
      sourceMaps: true,
    },
    integrations: [litsxUnoCss()],
  },
});
