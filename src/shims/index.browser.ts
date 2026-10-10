/**
 * Browser stub for all Node built-in modules used by lograil.
 * Selected over `index.ts` via the `browser` field in `package.json`.
 *
 * Functions that are never called in browser builds (FileTransport) throw
 * descriptive errors. Functions that have reasonable browser defaults
 * (tmpdir) return sensible values.
 */

// --- os ---
export function tmpdir(): string {
  return '/tmp';
}

// --- os platform ---
export function osPlatform(): string {
  // Browsers have no meaningful "platform"; return a sentinel so OS-native
  // transports can detect "not a supported platform" and no-op / onError.
  return 'browser';
}

// --- child_process (browser stubs — never available) ---
/**
 * Browser build: `spawn` / `execFile` are never installed. The OS-native
 * transports detect their absence via `typeof` at construction time and no-op
 * (or report via `onError`), so these stubs are only reached if a user
 * explicitly constructs the transport in a browser — they throw a clear
 * error instead of hanging.
 */
export function spawn(
  _cmd: string,
  _args?: string[],
  _opts?: unknown,
): { kill(): void; on(_event: string, _cb: (...a: unknown[]) => void): unknown } {
  throw new Error('child_process.spawn is not available in browser builds');
}

export function execFile(
  _cmd: string,
  _args: string[],
  _opts: unknown,
  cb: (err: unknown, stdout: string, stderr: string) => void,
): void {
  cb(new Error('child_process.execFile is not available in browser builds'), '', '');
}

// --- cluster ---
export function isClusterWorker(): boolean {
  return false;
}

// --- path ---
export function basename(p: string, ext?: string): string {
  const seg =
    p
      .replace(/[/\\]$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  if (!ext) return seg;
  return seg.endsWith(ext) ? seg.slice(0, -ext.length) : seg;
}

export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx <= 0 ? '.' : p.slice(0, idx);
}

export function join(...segments: string[]): string {
  return segments.filter(Boolean).join('/');
}

// --- fs/promises ---
const NOT_AVAILABLE = 'File system APIs are not available in browser builds';

export async function mkdir(_path: string, _options?: unknown): Promise<void> {
  throw new Error(NOT_AVAILABLE);
}

export async function open(
  _path: string,
  _flags?: string,
): Promise<{ fd: number; close(): Promise<void> }> {
  throw new Error(NOT_AVAILABLE);
}

export async function rename(_oldPath: string, _newPath: string): Promise<void> {
  throw new Error(NOT_AVAILABLE);
}

export async function rm(_path: string, _options?: unknown): Promise<void> {
  throw new Error(NOT_AVAILABLE);
}

export async function stat(_path: string): Promise<{ size: number; mtimeMs: number }> {
  throw new Error(NOT_AVAILABLE);
}

export async function readdir(_path: string): Promise<string[]> {
  throw new Error(NOT_AVAILABLE);
}
