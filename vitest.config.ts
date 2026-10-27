import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], restoreMocks: true, testTimeout: 20_000 },
});
