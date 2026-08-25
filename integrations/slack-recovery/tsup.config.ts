/** Emits an executable ESM artifact with the expected .mjs extension. */
import { defineConfig } from "tsup";

export default defineConfig({
  outExtension: () => ({ js: ".mjs" }),
});
