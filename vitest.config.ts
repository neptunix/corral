import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vitest does NOT read tsconfig `paths` — the @shared alias must be declared here too,
  // or every test importing `@shared/schema` (Tasks 2, 7, 8, 10, 11) fails to resolve.
  resolve: { alias: { "@shared": path.resolve(import.meta.dirname, "shared") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // environments.ts loads ENVIRONMENTS at import time from $CORRAL_CONFIG. A SETUP FILE (not
    // `test.env`) sets CORRAL_CONFIG before the test module graph evaluates, so adapter tests
    // (Tasks 5–8) + api.test resolve getEnv("work-local")/ENVIRONMENTS against the checked-in
    // fixture rather than the operator's real $CORRAL_HOME. `test.env` is applied too late — it
    // races the ESM module-init that reads the var, breaking the suite on CI / other machines.
    setupFiles: ["test/setup.ts"],
  },
});
