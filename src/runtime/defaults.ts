/**
 * Sensible disk-safety defaults for the built-in runtimes' default
 * `FileTransport` (mode `rotate-time`, daily). A zero-config logger must never
 * eat the disk, so the defaults bound every growth axis:
 *
 * - `maxSize` caps each file (the global caps never delete the active file,
 *   so the active file needs its own limit);
 * - `maxFiles` keeps roughly two weeks of daily buckets;
 * - `maxTotalSize` is the absolute disk ceiling (~200 MB) even if a single
 *   day produces far more data.
 *
 * Every value can be overridden via `fileTransportOptions`; passing `undefined`
 * keeps the default, while explicit values replace it.
 */

/** Max bytes per file: 10 MB. */
export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
/** Max daily buckets kept: 14 (about two weeks). */
export const DEFAULT_MAX_FILES = 14;
/** Absolute disk ceiling for all owned files: 200 MB. */
export const DEFAULT_MAX_TOTAL_SIZE = 200 * 1024 * 1024;

/** Default caps merged into the runtimes' default `FileTransport` options. */
export const DEFAULT_FILE_CAPS = {
  maxSize: DEFAULT_MAX_FILE_SIZE,
  maxFiles: DEFAULT_MAX_FILES,
  maxTotalSize: DEFAULT_MAX_TOTAL_SIZE,
} as const;
