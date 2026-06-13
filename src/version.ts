import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Package version, read from package.json at runtime so it stays in sync with
 * `npm version` instead of being hardcoded in multiple places.
 * Resolves to the package root from both dist/ (published) and src/ (tsx dev).
 */
export const VERSION: string = (require("../package.json") as { version: string }).version;
