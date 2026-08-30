/**
 * Node.js API shims — the single entry point for all Node built-in module
 * access in lograil. Every consumer imports from this module instead of
 * `node:*` directly, so browser builds can swap the whole file at once
 * via the `browser` field in `package.json`.
 *
 * If you need a new Node API, add the re-export here **and** the matching
 * stub in `index.browser.ts`. ESLint will flag any direct `node:*` import
 * outside this file.
 */

// --- os ---
export { tmpdir } from 'node:os';

// --- path ---
export { basename, dirname, join } from 'node:path';

// --- fs/promises ---
export { mkdir, open, rename, rm, stat, readdir } from 'node:fs/promises';
