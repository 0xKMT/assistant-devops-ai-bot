/** Bundles the configuration boundary into the standalone deployable plugin. */
import { defineConfig } from "tsup";

export default defineConfig({
  removeNodeProtocol: false,
  noExternal: ["@friday/shared"],
});
