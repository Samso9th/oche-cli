import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // One self-contained file: commander is bundled, @oche/core is type-only.
  noExternal: ["commander"],
  splitting: false,
  sourcemap: false,
  minify: false,
});
