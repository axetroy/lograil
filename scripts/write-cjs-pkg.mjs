// Writes dist/cjs/package.json marking the CJS build as CommonJS, so that
// `require()` works even though the project root is `"type": "module"`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const target = 'dist/cjs/package.json';
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify({ type: 'commonjs' }) + '\n');
