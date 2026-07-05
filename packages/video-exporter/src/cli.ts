#!/usr/bin/env node
import { parseArgs } from 'util';
import { exportVideo } from './index.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: {
      type: 'string',
      short: 'o',
      default: 'out.mp4',
    },
    width: {
      type: 'string',
      short: 'w',
      default: '1280',
    },
    height: {
      type: 'string',
      short: 'h',
      default: '720',
    },
    fps: {
      type: 'string',
      short: 'f',
      default: '60',
    },
    duration: {
      type: 'string',
      short: 'd',
      default: '5',
    },
  },
  allowPositionals: true,
});

const url = positionals[0];

if (!url) {
  console.error('Usage: vecto-export <url> [options]');
  console.error('Options:');
  console.error('  -o, --output <file>    Output file (default: out.mp4)');
  console.error('  -w, --width <pixels>   Width in pixels (default: 1280)');
  console.error('  -h, --height <pixels>  Height in pixels (default: 720)');
  console.error('  -f, --fps <number>     Frames per second (default: 60)');
  console.error('  -d, --duration <secs>  Duration in seconds (default: 5)');
  process.exit(1);
}

exportVideo({
  url,
  outputPath: values.output!,
  width: parseInt(values.width!, 10),
  height: parseInt(values.height!, 10),
  fps: parseInt(values.fps!, 10),
  duration: parseInt(values.duration!, 10),
}).catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
