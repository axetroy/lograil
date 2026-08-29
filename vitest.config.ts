import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Per-file `@vitest-environment jsdom` is used where a DOM is needed
    // (e.g. web runtime tests); the default environment stays node.
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'clover'],
      reportsDirectory: 'coverage',
      // Guardrail thresholds derived from the current baseline (measured
      // ~89% across statements/branches/functions/lines on the default suite).
      // CI fails if coverage drops below these, catching regressions.
      thresholds: {
        statements: 88,
        branches: 88,
        functions: 88,
        lines: 88,
      },
    },
  },
});
