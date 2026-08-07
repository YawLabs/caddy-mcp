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
    // Declarations come from `tsc -p tsconfig.build.json --emitDeclarationOnly`
    // in the build script, not from tsup. tsup 8.5.1 bundles
    // rollup-plugin-dts@6.1.1, which is built against TypeScript 5.x and
    // crashes on TS 7 with
    //   TypeError: Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')
    // The JS bundles emit fine; only the .d.ts step dies, which was enough to
    // fail `npm run build` and therefore `prepublishOnly` and release.sh.
    dts: false,
    clean: false,
    target: "node20",
  },
]);
