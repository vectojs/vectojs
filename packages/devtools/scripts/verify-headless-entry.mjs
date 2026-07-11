import { readFile, stat } from 'node:fs/promises';

const MAX_HEADLESS_BYTES = 100 * 1024;
const [source, declarations, metadata] = await Promise.all([
  readFile('dist/headless.mjs', 'utf8'),
  readFile('dist/headless.d.ts', 'utf8'),
  stat('dist/headless.mjs'),
]);
const forbidden = ['@vectojs/ui', 'mathjax', 'marked', './panel'].filter(
  (dependency) => source.toLowerCase().includes(dependency) || declarations.includes(dependency),
);

if (forbidden.length > 0)
  throw new Error(
    `The headless DevTools entry includes panel dependencies: ${forbidden.join(', ')}.`,
  );
if (metadata.size > MAX_HEADLESS_BYTES)
  throw new Error(
    `The headless DevTools entry is ${metadata.size} bytes; the budget is ${MAX_HEADLESS_BYTES} bytes.`,
  );

console.log(`Verified headless DevTools entry (${metadata.size} bytes).`);
