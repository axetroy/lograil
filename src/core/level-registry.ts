/**
 * A mutable registry of custom log-level names that extends the built-in
 * level table. The built-in names (`trace`…`fatal`) are declared here
 * verbatim so this module stays free of an import cycle back to `types.ts`
 * (which consults these lookups in `normalizeLevel` / `isLogLevelName`).
 *
 * Users can register additional named levels (e.g. `audit` at `45` for
 * security-critical logging between `info` and `error`) without modifying the
 * library. Registered names never shadow a built-in name.
 */

/** Built-in levels, mirroring `types.ts` LOG_LEVELS. Higher = more severe. */
const BUILTIN: Readonly<Record<string, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const registry = new Map<string, number>();

/**
 * The effective level table = built-ins + user registrations. Rebuilt lazily
 * only when a registration mutates the registry; with no custom levels the
 * frozen built-in record is reused so the hot path stays allocation-free.
 */
let effective: Record<string, number> | null = null;

function rebuild(): Record<string, number> {
  if (registry.size === 0) {
    effective = null;
    return BUILTIN;
  }
  const merged = { ...BUILTIN };
  for (const [name, value] of registry) merged[name] = value;
  effective = merged;
  return merged;
}

/** Returns a level value by name, consulting the user registry first. */
export function lookupLevel(name: string): number | undefined {
  const user = registry.get(name);
  if (user !== undefined) return user;
  return (effective ?? BUILTIN)[name];
}

/** True when the name is a known (built-in or registered) level. */
export function hasLevel(name: string): boolean {
  return registry.has(name) || name in BUILTIN;
}

/**
 * Register a custom level name. `value` must be a positive finite number that
 * does not collide with an already-known name (built-in or previously
 * registered). Throws on collision / bad input so a bad registration fails
 * fast rather than silently mis-ordering severity.
 *
 * @returns the accepted value.
 */
export function registerLevel(name: string, value: number): number {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('registerLevel: name must be a non-empty string');
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`registerLevel: value must be a positive finite number, got ${value}`);
  }
  if (hasLevel(name)) {
    throw new Error(
      `registerLevel: '${name}' is already a known level (built-in or pre-registered)`,
    );
  }
  registry.set(name, value);
  rebuild();
  return value;
}

/**
 * Unregister a custom level. Built-in names cannot be unregistered — they are
 * part of the public contract.
 *
 * @returns `true` if a user-registered entry was removed; `false` for
 * built-ins and unknown names (no-op).
 */
export function unregisterLevel(name: string): boolean {
  if (!registry.has(name)) return false;
  registry.delete(name);
  rebuild();
  return true;
}

/** All custom level names (excluding built-ins). Safe to iterate. */
export function listCustomLevels(): string[] {
  return Array.from(registry.keys());
}

/**
 * For test isolation / plugin teardown: remove every user-registered level and
 * restore the built-in table. Not intended for normal application code.
 */
export function _resetLevelRegistry(): void {
  registry.clear();
  rebuild();
}
