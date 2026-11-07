import { configDefaults, defineConfig } from "vitest/config";

// console/ is a self-contained Bun app with its own package.json and tests (PR #23); the root suite skips it.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "console/**"] },
});
