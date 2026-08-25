import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "^(.+\\.js)$": "$1",
    },
  },
});