import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

// This launches the REAL Electron binary, so it is opt-in: it only runs when
// `RUN_ELECTRON_INTEGRATION=1` is set AND the package has been built (`dist/`
// exists). The normal `yarn test` / CI matrix skip it; the optional CI job
// (or a local run) enables it after `yarn build`.
const RUN = process.env.RUN_ELECTRON_INTEGRATION === '1';
const distReady = existsSync(join(process.cwd(), 'dist', 'esm', 'index.js'));

const describeIf = RUN && distReady ? describe : describe.skip;

describeIf('integration: real Electron app (renderer -> main IPC + file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lograil-electron-int-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('forwards renderer logs to the main process and writes real files', async () => {
    const electronPath = require('electron');
    const fixture = join(__dirname, '..', 'fixtures', 'electron-app', 'main.cjs');
    const env = { ...process.env, LOGRAIL_TEST_DIR: dir };

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(electronPath, ['--headless', fixture], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      child.stdout.on('data', (d) => (buf += d.toString()));
      child.stderr.on('data', (d) => (buf += d.toString()));
      const timer = setTimeout(
        () => reject(new Error(`electron integration timed out\n${buf}`)),
        30000,
      );
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(buf);
      });
      child.on('error', reject);
    });

    expect(output).toContain('LOGRAIL_DONE');

    const mainLog = join(dir, 'main.log');
    const rendererLog = join(dir, 'renderer.log');
    if (!existsSync(rendererLog)) {
      throw new Error(`renderer.log missing\n--- captured output ---\n${output}`);
    }
    const mainText = readFileSync(mainLog, 'utf8');
    const rendererText = readFileSync(rendererLog, 'utf8');

    // Main-process entries landed in main.log.
    expect(mainText).toContain('hello from main');
    expect(mainText).toContain('main done');
    // Renderer-process entries were forwarded over IPC and written to renderer.log.
    expect(rendererText).toContain('hello from renderer');
    expect(rendererText).toContain('renderer warning');
  }, 40000);
});
