export function getNavigation() { throw new Error("Navigation is only available in a browser context."); }
export { createHref } from "./navigation-url.js";
export function useNavigation() { throw new Error("useNavigation() is only available in a browser component."); }
