import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = join(packageRoot, 'dist');
const requiredFiles = ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js'];
const failures = [];

for (const file of requiredFiles) {
  if (!existsSync(join(packageRoot, file))) failures.push(`missing ${file}`);
}

const cliPath = join(packageRoot, 'dist/cli.js');
if (existsSync(cliPath) && (statSync(cliPath).mode & 0o111) === 0) {
  failures.push('dist/cli.js is not executable');
}

function walk(directory) {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) {
        failures.push(`test artifact ${relative(packageRoot, path)}`);
      }
      if (entry.name.endsWith('.map')) {
        const contents = readFileSync(path, 'utf8');
        if (contents.includes(packageRoot) || /\/(?:mnt|home)\//.test(contents)) {
          failures.push(`source map exposes a workspace path ${relative(packageRoot, path)}`);
        }
      }
    }
  }
}

walk(distRoot);

if (failures.length > 0) {
  console.error(`Invalid publish output:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('Video exporter publish output is clean.');
