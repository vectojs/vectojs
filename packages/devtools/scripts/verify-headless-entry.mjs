import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_HEADLESS_BYTES = 100 * 1024;
const [source, metadata] = await Promise.all([
  readFile('dist/headless.mjs', 'utf8'),
  stat('dist/headless.mjs'),
]);
const visitedDeclarations = new Set();
const declarationModules = new Set();

async function collectDeclarationModules(path) {
  const absolutePath = resolve(path);
  if (visitedDeclarations.has(absolutePath)) return;
  visitedDeclarations.add(absolutePath);
  const declarations = await readFile(absolutePath, 'utf8');
  const imports = declarations.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/gu);
  for (const [, dependency] of imports) {
    declarationModules.add(dependency);
    if (dependency.startsWith('.'))
      await collectDeclarationModules(resolve(dirname(absolutePath), `${dependency}.d.ts`));
  }
}

await collectDeclarationModules('dist/headless.d.ts');

const forbidden = ['@vectojs/ui', 'mathjax', 'marked', './panel'].filter((dependency) =>
  source.toLowerCase().includes(dependency),
);
const forbiddenTypes = [...declarationModules].filter(
  (dependency) => dependency === '@vectojs/ui' || dependency.startsWith('@vectojs/ui/'),
);

if (forbidden.length > 0)
  throw new Error(
    `The headless DevTools entry includes panel dependencies: ${forbidden.join(', ')}.`,
  );
if (forbiddenTypes.length > 0)
  throw new Error(
    `The headless DevTools types include UI dependencies: ${forbiddenTypes.join(', ')}.`,
  );
if (metadata.size > MAX_HEADLESS_BYTES)
  throw new Error(
    `The headless DevTools entry is ${metadata.size} bytes; the budget is ${MAX_HEADLESS_BYTES} bytes.`,
  );

console.log(`Verified headless DevTools entry (${metadata.size} bytes).`);
