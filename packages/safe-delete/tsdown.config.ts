import { defineConfig } from "tsdown"

// The types read config's built kinds, since tsgo writes a file it compiles from outside the package beside that file's source.
export default defineConfig({
  dts: { tsconfig: "tsconfig.build.json" },
  entry: ["src/index.ts"],
  minify: true,
  outDir: "dist",
})
