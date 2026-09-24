import { litsxUnoCss } from "@litsx/unocss";

export default {
  litsx: {
    compiler: {
      sourceMaps: true,
    },
    integrations: [litsxUnoCss()],
  },
};

