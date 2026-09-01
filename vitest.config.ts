import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Per-file `@vitest-environment jsdom` is used where a DOM is needed
    // (e.g. web runtime tests); the default environment stays node.
    include: ['test/**/*.test.ts', 'bench/**/*.bench.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', 'dist/**', 'bench/**/*.bench.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'clover'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Exclude code that has no executable statements to cover: build scripts,
      // browser-only stubs (exercised under a jsdom/playwright env, not node),
      // and pure type-declaration modules (interfaces only — v8 reports them at
      // 0% which would unfairly drag the average). Measuring these is noise, not
      // signal.
      exclude: [
        'scripts/**',
        '**/*.browser.ts',
        'src/plugin/plugin.ts',
        'src/transport/transport.ts',
        'src/runtime/adapter.ts',
      ],
      // Guardrail thresholds: CI fails if coverage drops below these, so any
      // regression in the runtime code is caught before it ships.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
