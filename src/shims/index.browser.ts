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
