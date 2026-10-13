import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "local-error-log.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  external: ["openclaw/*"],
  noExternal: ["@friday/shared"],
  outDir: "dist",
  clean: true,
});
