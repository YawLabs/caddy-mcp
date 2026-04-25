import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { server: "src/server.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    target: "node20",
  },
]);
