import { describe, it, expect } from 'vitest';
import { createContextStore } from '../src/context/index.js';

describe('ContextStore', () => {
  it('stores and reads values', () => {
    const ctx = createContextStore();
    ctx.set('user', 'alice');
    expect(ctx.get().user).toBe('alice');
  });

  it('merges values', () => {
    const ctx = createContextStore({ a: 1 });
    ctx.merge({ b: 2, a: 3 });
    expect(ctx.get()).toEqual({ a: 3, b: 2 });
  });

  it('child inherits and is isolated', () => {
    const parent = createContextStore({ a: 1 });
    const child = parent.child();
    child.set('b', 2);
    expect(parent.get()).toEqual({ a: 1 });
    expect(child.get()).toEqual({ a: 1, b: 2 });
  });

  it('clears', () => {
    const ctx = createContextStore({ a: 1 });
    ctx.clear();
    expect(ctx.get()).toEqual({});
  });

  it('deletes a single key', () => {
    const ctx = createContextStore({ a: 1, b: 2 });
    ctx.delete('a');
    expect(ctx.get()).toEqual({ b: 2 });
    expect(ctx.get()).not.toHaveProperty('a');
  });
});
