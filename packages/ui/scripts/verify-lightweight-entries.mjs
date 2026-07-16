import { build } from 'esbuild';

const entries = [
  { name: 'Input', path: './dist/Input.mjs' },
  { name: 'Text', path: './dist/Text.mjs' },
  { name: 'measure', path: './dist/measure.mjs' },
  { name: 'ContextMenu', path: './dist/ContextMenu.mjs' },
];

for (const entry of entries) {
  const result = await build({
    stdin: {
      contents: `export * from '${entry.path}';`,
      resolveDir: process.cwd(),
      sourcefile: `${entry.name.toLowerCase()}-entry-consumer.mjs`,
    },
    bundle: true,
    external: ['@vectojs/core'],
    format: 'esm',
    metafile: true,
    platform: 'browser',
    treeShaking: false,
    write: false,
  });

  const forbiddenInputs = Object.keys(result.metafile.inputs).filter((path) =>
    /(?:^|\/)(?:marked|mathjax-full)(?:\/|$)|Markdown(?:Worker|\.ts)/u.test(path),
  );

  if (forbiddenInputs.length > 0) {
    throw new Error(
      `The lightweight ${entry.name} entry pulled content-rendering dependencies:\n${forbiddenInputs.join('\n')}`,
    );
  }

  const bytes = result.outputFiles.reduce((total, output) => total + output.contents.byteLength, 0);
  console.log(
    `Verified lightweight ${entry.name} entry (${bytes} bundled bytes, excluding @vectojs/core).`,
  );
}
