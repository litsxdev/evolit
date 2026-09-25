import { litsxTailwind } from "@litsx/tailwind";
import { defineEvolitConfig } from "evolit/litsx";

export default defineEvolitConfig({
  litsx: {
    compiler: { sourceMaps: true },
    integrations: [
      litsxTailwind({ integration: { entry: "./tailwind.css" } }),
    ],
  },
});
