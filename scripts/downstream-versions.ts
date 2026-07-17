import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const pkgs = readdirSync('packages');
const versions: Record<string, string> = {};

for (const p of pkgs) {
  try {
    const json = JSON.parse(readFileSync(join('packages', p, 'package.json'), 'utf-8'));
    if (json.name?.startsWith('@vectojs/')) {
      versions[json.name] = `^${json.version}`;
    }
  } catch {}
}

console.log('=== Current @vectojs/* versions ===');
for (const [k, v] of Object.entries(versions)) {
  console.log(`${k}@${v.replace('^', '')}`);
}
console.log('');
console.log('Downstream dependencies block:');
console.log(JSON.stringify(versions, null, 2));
