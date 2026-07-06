import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function findWorkspaceRoot(start) {
  let current = resolve(start);
  while (dirname(current) !== current) {
    if (existsSync(join(current, 'vectojs')) && existsSync(join(current, 'tmp'))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not find the VectoJS workspace from ${start}`);
}

const workspaceRoot = findWorkspaceRoot(packageRoot);
const scratch = await mkdtemp(join(workspaceRoot, 'tmp/video-exporter-consumer-'));

try {
  const packDirectory = join(scratch, 'pack');
  const consumerDirectory = join(scratch, 'consumer');
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  await execFileAsync('bun', ['run', 'build'], { cwd: packageRoot });
  await execFileAsync('node', ['scripts/verify-package.js'], { cwd: packageRoot });
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    { cwd: packageRoot },
  );
  const packResult = JSON.parse(stdout);
  const tarball = join(packDirectory, packResult[0].filename);

  await execFileAsync('npm', ['init', '--yes'], { cwd: consumerDirectory });
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', tarball],
    { cwd: consumerDirectory },
  );
  await execFileAsync(
    'node',
    [
      '--input-type=module',
      '--eval',
      `import { createRequire } from 'node:module';
       import { exportVideo } from '@vectojs/video-exporter';
       if (typeof exportVideo !== 'function') throw new Error('exportVideo is not a function');
       const packageUrl = import.meta.resolve('@vectojs/video-exporter');
       createRequire(packageUrl).resolve('vite');`,
    ],
    { cwd: consumerDirectory },
  );

  const installed = JSON.parse(
    await readFile(
      join(consumerDirectory, 'node_modules/@vectojs/video-exporter/package.json'),
      'utf8',
    ),
  );
  if (!installed.dependencies?.vite) throw new Error('Published package does not declare Vite');
  console.log('Video exporter package works in a clean consumer project.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
