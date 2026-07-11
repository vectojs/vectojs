import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: "export { Input } from './dist/Input.mjs';",
    resolveDir: process.cwd(),
    sourcefile: 'input-entry-consumer.mjs',
  },
  bundle: true,
  external: ['@vectojs/core'],
  format: 'esm',
  metafile: true,
  platform: 'browser',
  write: false,
});

const forbiddenInputs = Object.keys(result.metafile.inputs).filter((path) =>
  /(?:^|\/)(?:marked|mathjax-full)(?:\/|$)|Markdown(?:Worker|\.ts)/u.test(path),
);

if (forbiddenInputs.length > 0) {
  throw new Error(
    `The lightweight Input entry pulled content-rendering dependencies:\n${forbiddenInputs.join('\n')}`,
  );
}

const bytes = result.outputFiles.reduce((total, output) => total + output.contents.byteLength, 0);
console.log(`Verified lightweight Input entry (${bytes} bundled bytes, excluding @vectojs/core).`);
