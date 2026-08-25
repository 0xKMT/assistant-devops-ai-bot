/** Build policy for the deployable OpenClaw security plugin bundle. */
import { defineConfig } from "tsup";

export default defineConfig({
  banner: { js: "// Friday Security & Persona Shield v1" },
  removeNodeProtocol: false,
  sourcemap: false,
  minify: false,
});
