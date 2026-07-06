import { spawn } from 'child_process';
import puppeteer from 'puppeteer';
import { createServer, ViteDevServer } from 'vite';
import * as path from 'path';
import * as fs from 'fs/promises';
import cliProgress from 'cli-progress';
import type { ExportOptions } from './options.js';

export type { ExportOptions } from './options.js';

export async function exportVideo(options: ExportOptions) {
  const fps = options.fps || 60;
  const duration = options.duration || 5; // seconds
  const totalFrames = fps * duration;
  const dt = 1000 / fps;

  let viteServer: ViteDevServer | null = null;
  let targetUrl = options.url;
  let tempHtmlPath: string | null = null;

  // Check if it's a local file instead of a URL
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    const absPath = path.resolve(targetUrl);
    const dir = path.dirname(absPath);
    const filename = path.basename(absPath);

    tempHtmlPath = path.join(dir, '.vecto-export-temp.html');
    const htmlContent = `<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8"><style>body{margin:0;overflow:hidden;background:#000;}</style></head>
  <body>
    <canvas id="app"></canvas>
    <script type="module" src="./${filename}"></script>
  </body>
</html>`;

    await fs.writeFile(tempHtmlPath, htmlContent);

    viteServer = await createServer({
      root: dir,
      server: { port: 0 },
      logLevel: 'silent',
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address() as any;
    targetUrl = `http://localhost:${address.port}/.vecto-export-temp.html`;
    console.log(`Started internal Vite server on port ${address.port}`);
  }

  console.log(`Starting export: ${options.url} -> ${options.outputPath}`);
  console.log(
    `Resolution: ${options.width}x${options.height}, FPS: ${fps}, Duration: ${duration}s`,
  );

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });

  console.log(`Loading URL: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle0' });

  // Wait for scene to be ready
  try {
    await page.waitForFunction('!!window.vectoScene', { timeout: 10000 });
  } catch (e) {
    console.error('Error: window.vectoScene was not found on the page within 10 seconds.');
    await browser.close();
    if (viteServer) await viteServer.close();
    if (tempHtmlPath) await fs.unlink(tempHtmlPath).catch(() => {});
    throw e;
  }

  // Stop the scene's normal clock if it's running
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).vectoScene.stop();
  });

  // Spawn ffmpeg
  const ffmpeg = spawn('ffmpeg', [
    '-y', // overwrite
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-r',
    fps.toString(),
    '-i',
    '-', // stdin
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    options.outputPath,
  ]);

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (data) => {
    ffmpegError += data.toString();
  });

  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(totalFrames, 0);

  for (let i = 0; i < totalFrames; i++) {
    // Step the scene
    await page.evaluate((deltaTime) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).vectoScene.step(deltaTime);
    }, dt);

    // Capture canvas
    const base64Str = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('No canvas found');
      return canvas.toDataURL('image/png').split(',')[1];
    });

    const buffer = Buffer.from(base64Str, 'base64');

    // Write to ffmpeg
    if (!ffmpeg.stdin.write(buffer)) {
      await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
    }

    bar.update(i + 1);
  }

  bar.stop();
  ffmpeg.stdin.end();

  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`FFmpeg exited with code ${code}. Error: ${ffmpegError}`));
    });
  });

  await browser.close();

  if (viteServer) await viteServer.close();
  if (tempHtmlPath) await fs.unlink(tempHtmlPath).catch(() => {});

  console.log(`\nExport complete: ${options.outputPath}`);
}
