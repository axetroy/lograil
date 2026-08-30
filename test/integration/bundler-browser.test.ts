// @vitest-environment node
/**
 * Bundler integration tests — verify that lograil can be bundled for the
 * browser without pulling in any Node built-in modules.
 *
 * Uses esbuild with `platform: 'browser'` and an onResolve plugin that
 * intercepts Node-only modules and redirects to browser stubs. This
 * simulates how real bundlers (webpack, Vite, Parcel) honor the
 * `browser` field in package.json.
 */
import { describe, expect, it } from 'vitest';
import { build, type Plugin } from 'esbuild';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BROWSER_BUILD = {
  bundle: true as const,
  format: 'esm' as const,
  platform: 'browser' as const,
  write: false as const,
  logLevel: 'error' as const,
};

/**
 * esbuild plugin that swaps Node-only source files for browser stubs.
 * Simulates the `browser` field resolution that real bundlers perform.
 */
function browserSwapsPlugin(): Plugin {
  return {
    name: 'browser-swaps',
    setup(build) {
      // shims/index.ts → index.browser.ts
      build.onResolve({ filter: /shims[/\\]index/ }, () => ({
        path: join(ROOT, 'src', 'shims', 'index.browser.ts'),
      }));
      // context/async-context.ts → async-context.browser.ts
      build.onResolve({ filter: /async-context\.js$/ }, () => ({
        path: join(ROOT, 'src', 'context', 'async-context.browser.ts'),
      }));
      // runtime/electron-binding.ts → electron-binding.browser.ts
      build.onResolve({ filter: /electron-binding\.js$/ }, () => ({
        path: join(ROOT, 'src', 'runtime', 'electron-binding.browser.ts'),
      }));
    },
  };
}

async function bundle(entry: string): Promise<string> {
  const result = await build({
    ...BROWSER_BUILD,
    entryPoints: [join(ROOT, entry)],
    plugins: [browserSwapsPlugin()],
  });
  return result.outputFiles[0].text;
}

describe('bundler integration: browser build', () => {
  it('bundles the main entry without node:* imports', async () => {
    const code = await bundle('src/index.ts');

    // No `node:` bare specifier should leak into the browser bundle.
    expect(code).not.toMatch(/['"]node:[^'"]+['"]/);

    // Smoke: the bundle should export the public API symbols.
    expect(code).toContain('createLogger');
    expect(code).toContain('logger');
  });

  it('bundles transport subpath without node:* imports', async () => {
    const code = await bundle('src/transport/index.ts');

    expect(code).not.toMatch(/['"]node:[^'"]+['"]/);
    expect(code).toContain('FileTransport');
  });

  it('bundles runtime subpath without node:* imports', async () => {
    const code = await bundle('src/runtime/index.ts');

    expect(code).not.toMatch(/['"]node:[^'"]+['"]/);
    expect(code).toContain('createWebRuntime');
    expect(code).toContain('createNodeRuntime');
  });

  it('shims/index.browser.ts is used in place of index.ts', async () => {
    const code = await bundle('src/shims/index.ts');

    // The browser shim's tmpdir should return '/tmp' (not call os.tmpdir()).
    expect(code).toContain('/tmp');

    // The real node:os import should not appear.
    expect(code).not.toMatch(/['"]node:[^'"]+['"]/);
  });

  it('produces a browser-evaluable bundle', async () => {
    const code = await bundle('src/index.ts');

    // Dynamic-import the ESM bundle to verify it loads without throwing.
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const tmpFile = join(ROOT, 'dist', '_browser-test.mjs');
    writeFileSync(tmpFile, code);
    try {
      const mod = await import(pathToFileURL(tmpFile).href);
      expect(mod.createLogger).toBeTypeOf('function');
      expect(mod.logger).toBeDefined();
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('FileTransport fs functions are stubbed in browser bundle', async () => {
    const code = await bundle('src/transport/file.ts');

    // FileTransport class should be in the bundle.
    expect(code).toContain('FileTransport');

    // The browser stub's throw message should appear (fs is not available).
    expect(code).toContain('not available in browser');
  });
});
