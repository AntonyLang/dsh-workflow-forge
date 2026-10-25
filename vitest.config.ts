import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@workflow-forge/spec": resolve("./packages/spec/src/index.ts"),
      "@workflow-forge/checks": resolve("./packages/checks/src/index.ts"),
      "@workflow-forge/compiler": resolve("./packages/compiler/src/index.ts"),
      "@workflow-forge/runtime": resolve("./packages/runtime/src/index.ts"),
      "@workflow-forge/packager": resolve("./packages/packager/src/index.ts"),
      "@workflow-forge/author": resolve("./packages/author/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
