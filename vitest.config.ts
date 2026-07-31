import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = __dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@quoteops/shared": path.resolve(root, "packages/shared/src/index.ts"),
      "@quoteops/contracts": path.resolve(root, "packages/contracts/src/index.ts"),
      "@quoteops/quote-core": path.resolve(root, "packages/quote-core/src/index.ts"),
      "@quoteops/connectors": path.resolve(root, "packages/connectors/src/index.ts"),
      "@quoteops/criteria": path.resolve(root, "packages/criteria/src/index.ts"),
      "@quoteops/audit": path.resolve(root, "packages/audit/src/index.ts"),
      "@quoteops/agent": path.resolve(root, "apps/agent/src/index.ts"),
      "@quoteops/control-plane": path.resolve(root, "apps/control-plane/src/index.ts"),
      "@quoteops/api": path.resolve(root, "apps/api/src/index.ts")
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts",
      "deploy/appliance/tests/**/*.test.ts",
      "scripts/**/*.test.ts"
    ],
    setupFiles: ["./vitest.setup.ts"]
  }
});

