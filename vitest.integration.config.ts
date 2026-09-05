import { defineConfig } from "vitest/config";

process.loadEnvFile(".env.test");

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
