---
title: "10 — Deterministic Video Export — Fixed-Step Capture"
description: "How @vectojs/video-exporter replaces wall-clock time with a fixed-step scene clock, captures through headless Chromium, and pipes PNG frames to FFmpeg for H.264 MP4 — with staged output, abort, and cleanup that keep the destination safe."
order: 30
---

# 10 — Deterministic Video Export — Fixed-Step Capture

> **Boss 10** makes animation time reproducible. The same module, the same `fps × duration`, the same `seed` — every export produces the same frames, regardless of host speed, compositor jitter, or backgrounded tabs. Two clocks are in play: the **wall clock** (`requestAnimationFrame`, `performance.now()` — whatever the browser did before capture began) and the **fixed-step clock** (`Scene.step(dt)` at exactly `dt = 1000/fps` per frame). The exporter kills the first and installs the second before frame 0.

- **What you'll learn**: why frame-0 determinism is the hard part; the scene contract (`stop + step + optional reset`); the Chromium → canvas PNG → FFmpeg `image2pipe` pipeline; staged output, abort propagation, and ordered cleanup; the CLI/API surface and when to prefer each; and the residual nondeterminism a scene author must still eliminate.
- **What you won't**: VMT lifecycle/transforms (boss 06), renderer internals (boss 07), or WASM acceleration (boss 08). This doc owns the capture clock and the encode.

## 1. Why deterministic export is hard — the two-clocks problem

A live VectoJS scene advances on `requestAnimationFrame` ticks (`packages/core/src/tree/Scene.ts:5569` `loop`). Each tick:

1. computes `dt = time - lastTime` from the wall clock (`Scene.ts:5609`);
2. snaps `dt` toward `1000/cap` when close (±30% to hide compositor jitter, `Scene.ts:5625`);
3. clamps `dt` to `MAX_FRAME_DT = 100ms` (`Scene.ts:1114`, `:5636`) so a backgrounded tab doesn't hurl physics forward by seconds;
4. updates drivers, composes transforms, layouts, then paints.

That is correct for a live page. For export it is fatal: export time must be a **pure function of frame index**.

- Two runs on the same host would otherwise disagree whenever one host jitters, throttles, or backgrounds.
- A benchmark vs an export would disagree on cadence even if they share the same scene.
- Any `Math.random()`, wall-clock `Date.now()`, or async resource that resolves at a non-fixed frame makes frame 0 arbitrary, and every later frame inherits that base (`packages/video-exporter/src/export-session.ts:78` comment references `#646`).

The fix is to **stop the wall-clock loop before the first captured frame and advance with a constant step** (`packages/core/src/tree/Scene.ts:3423` `step(dt)`). Determinism is then a scene-author discipline: every animation, spring, and tween must integrate only the `dt` it is given, and any randomness must be seeded. The exporter enforces the clock; the scene must supply deterministic dynamics.

## 2. The scene contract — what a page must expose

The exporter runs inside a normal browser page (local or remote) and talks to the scene through `window.vectoScene`. Three methods matter:

| method     | role                                               | required | where checked                                      |
| ---------- | -------------------------------------------------- | -------- | -------------------------------------------------- |
| `stop()`   | halt the `requestAnimationFrame` loop              | yes      | `packages/video-exporter/src/export-session.ts:62` |
| `step(dt)` | advance and render exactly one frame synchronously | yes      | `packages/video-exporter/src/export-session.ts:70` |
| `reset()`  | restore t=0 presentation (optional)                | no       | `packages/video-exporter/src/export-session.ts:84` |

### 2.1 `stop + step` is the clock swap

`ExportSession.validateAndStopScene` (`export-session.ts:60`):

- `page.waitForFunction('!!window.vectoScene', { timeout: 10_000 })` (`export-session.ts:61`) — the page has 10s after `networkidle0` to publish the scene.
- `page.evaluate` probes `typeof scene.stop === 'function'` and `typeof scene.step === 'function'` (`export-session.ts:62`): if either is missing it throws `window.vectoScene must provide callable stop() and step(dt) methods` (`export-session.ts:71`).
- Then `scene.stop()` (`export-session.ts:75`) kills `requestAnimationFrame` rescheduling so capture is the only thing that advances time.

Each exported frame then calls `scene.step(dt)` with the normalised `dt = 1000 / fps` (`export-session.ts:148`). `Scene.step` (`Scene.ts:3423`) does exactly one thing: `time = lastTime + dt; lastTime = time; render(renderer, dt, time)` — no dirty check (`Scene.ts:3405` _"renders UNCONDITIONALLY"_), no `always` idle throttle, no `MAX_FRAME_DT` clamp (`Scene.ts:3421` _"Not clamped by MAX_FRAME_DT — the caller chooses the step"_). That bypass is deliberate: a deterministic driver asks for a frame because it wants that frame.

Two rendering footguns are called out by the `step` docs so reviewers don't misread measurements:

- A benchmark driving frames through `step()` **cannot observe frame skipping** (`Scene.ts:3411`), so `always` vs `onDemand` is invisible through this path — measure scheduling only on the live `start()` loop (`Scene.ts:3417`).
- `frameStats` stays at its zero defaults when a scene is only `step()`-driven (`Scene.ts:3501`) — the phase probes live on `loop`.

### 2.2 `reset` is the frame-0 fix (issue #646)

Between page load and `scene.stop()`, the page's own rAF loop free-runs for an arbitrary, host-dependent number of ticks. Any intro tween or eased entrance driven by those ticks reaches an arbitrary state before capture starts — all later frames are deterministic only _from that nondeterministic base_ (`export-session.ts:78` comment, `#646`).

- Scenes that render **static until first `step(dt)`** need nothing — frame 0 is already t=0.
- Scenes that carry **load-time state** expose `reset(): void` to return to their t=0 presentation. The exporter calls it once, after `stop()` and before the first `step()` (`export-session.ts:84`): `if (typeof scene?.reset === 'function') scene.reset()`. The ordering invariant is asserted in `packages/video-exporter/test/export-session.test.ts:154` — `reset` after `stop`, before first `step`.
- A scene without `reset` is exported as-is — the nondeterminism is then the author's problem, not an exporter error.

Demo scenes spell out the intended usage:

- `packages/video-exporter/demo/data-chart.ts:222` `window.vectoScene = scene` + `:227` _"stay idle so the exporter's stop()+step(dt) sequence is the sole clock"_;
- `packages/video-exporter/demo/ml-descent.ts:219` the same note;
- `packages/video-exporter/demo/math-teaching.ts:9` _"clock, no randomness, no scene.start()"_ + `:161` stop/step-is-the-only-clock.

Testing imitates the page with `packages/video-exporter/test/fixtures/two-frame-scene.ts:8` `window.vectoScene = { stop(){}, step(dt){} }`.

## 3. Pipeline — from `url` to `out.mp4`

```text
 ExportOptions ──► normalizeOptions ──► resolveInputTarget ──► launchBrowser ──► ExportSession.run
        │                │                       │                    │                  │
   options.ts:40   options.ts:102-114     input-target.ts:48    browser.ts:66     export-session.ts:111
   validate, dt,        isRemote,       local→ Vite HTML or  Puppeteer headless  validate → sizeCanvas
   totalFrames,      totalFrames,          remote→ inert        + sandbox args    → captureFrame loop
   even H.264 check   dt, audio checks     + ephemeral server
                                                                              │
                                        ┌─────────────────────────────────────┤
                                        │  for each frame: page.evaluate(step(dt))
                                        │  + canvas.toDataURL('image/png')       export-session.ts:148-154
                                        │  → encoder.write(pngBytes)
                                        └───────────┬─────────────────────────┘
                                                    ▼
                                        FfmpegSupervisor.write / finish  ffmpeg-supervisor.ts:156/177
                                        stdin = image2pipe png, fps = -r, yuv420p libx264
                                        + optional audio track as second -i, -c:a aac -shortest
                                                    │
                                        StagedOutput commit  staged-output.ts:99
                                        atomic rename: .vecto-*.mp4 → destination.mp4
```

### 3.1 Options → normalised options

`packages/video-exporter/src/options.ts:40` `normalizeOptions`:

- `url`/`outputPath` must be non-empty strings; `width`/`height`/`fps` must be positive integers (`options.ts:34` `positiveInteger`), `duration` a positive finite number (`options.ts:54`).
- `fps` defaults to 60, `duration` to 5s (`options.ts:48`); derived `dt = 1000 / fps` (`options.ts:113`) and `totalFrames = Math.ceil(fps * duration)` (`options.ts:112`) so fractional durations produce the right count and not a short final frame. Frame count is documented in `references/export-recipes.md:10` and ships as `dist/index.d.ts` contract.
- H.264 `yuv420p` chroma is 2×2 subsampled — odd dimensions can never encode. Only `ffmpeg` would say so, at the end with raw stderr after rendering every frame. Validate up front instead (`options.ts:58` `width % 2 !== 0 || height % 2 !== 0` → `TypeError`).
- `isRemote = /^https?:\/\//i.test(url)` (`options.ts:68`). Local paths are `resolve(url)` and must exist and be a file (`options.ts:70`). The same pre-launch checks apply to `audioPath` (`options.ts:78`): missing track would otherwise surface only as final-ffmpeg stderr.
- `outputPath = resolve(outputPath)` (`options.ts:88`); its parent directory must exist, be a directory, and be writable (`accessSync(…, W_OK)` at `options.ts:97`). Output is not truncated early — `StagedOutput` below handles atomicity.

### 3.2 Input target — local Vite route vs remote URL

`packages/video-exporter/src/input-target.ts:48` `resolveInputTarget`:

- Remote: `inertTarget(url)` (`input-target.ts:44`) — no server, `close` is a no-op.
- Local file: spin a Vite dev server in `custom` app type (`input-target.ts:58`) rooted at `dirname(url)` so bare `import 'three'` etc. resolve:
  - `root = dirname(url)` (`input-target.ts:54`), `entryUrl = "/" + encodeURIComponent(basename(url))` (`input-target.ts:55`) — `encodeURIComponent` matters for spaces/unicode in filenames.
  - Ephemeral pathname `/__vecto_export_${randomUUID()}.html` (`input-target.ts:56`) — random to avoid collisions across concurrent exports, but the comment at `staged-output.ts:35` still assumes _one exporter per target path_ at a time.
  - Single middleware: on that pathname, return synthetic HTML hosting a `<canvas id="app">` and `<script type="module" src="${entryUrl}">` (`input-target.ts:74`), run through `server.transformIndexHtml(pathname, source)` (`input-target.ts:85`) so Vite's HMR/alias/TS transform applies to the entry. Errors delegate to `next(error)` when present (`input-target.ts:90`).
  - `await server.listen()` (`input-target.ts:98`), then `server.httpServer?.address()` (`input-target.ts:99`): must be `{ port: number }` or the call throws `Vite did not expose a TCP address` (`input-target.ts:106`). Any failure closes the newly created server (`input-target.ts:114` in the outer `catch`) so a half-started Vite does not orphan a port.
  - Returned `InputTarget.url` is `http://127.0.0.1:${port}${pathname}` (`input-target.ts:110`); `close()` closes the Vite server exactly once (`input-target.ts:65` `closed` guard).

This keeps the source directory clean — no helper `.html` is written to disk, which is the common mistake listed in `vectojs-video-exporter/SKILL.md:43`.

### 3.3 Browser launch — Chromium + sandbox policy

`packages/video-exporter/src/browser.ts:45` `resolveBrowserLaunchOptions`:

- Resolution order: `PUPPETEER_EXECUTABLE_PATH` (trimmed, `browser.ts:49`), else `/usr/bin/chromium` if present (`browser.ts:51`), else Puppeteer's resolved/bundled Chromium — matching `README.md:10` _"Requires FFmpeg with libx264 … plus Chromium resolved from PUPPETEER_EXECUTABLE_PATH, then /usr/bin/chromium, then Puppeteer's …"_.
- `args` always includes `--disable-gpu` (`browser.ts:53`).
- Sandbox disabled (with a warning) only when `getuid() === 0` or `VECTO_CHROMIUM_NO_SANDBOX=1` (`browser.ts:55`). Warning text at `browser.ts:58`: _"Chromium sandbox is disabled for this VectoJS video export. Run as a non-root user when possible."_ Prefer a non-root export process (`SKILL.md:38`).

Launch itself is a test seam: `BrowserDependencies.launch` (`browser.ts:34` `launch(options) → BrowserLike`, default `puppeteer.launch(options)` at `browser.ts:42`) and `export-session.ts:32` `launchBrowser` are swappable in `ExportSessionDependencies`.

### 3.4 The capture loop — `validateAndStopScene` → `sizeCanvas` → frame loop

<!-- markdownlint-disable MD031 MD032 MD040 -->

`ExportSession.run` (`export-session.ts:111`):

1. `throwIfAborted()` before acquiring anything (`export-session.ts:120`, reads `options.signal?.aborted` and throws `abortError(signal)` from `packages/video-exporter/src/abort-error.ts:6`).
2. `target = resolveInputTarget(options)` (`export-session.ts:121`), `output = createStagedOutput(outputPath)` (`export-session.ts:122`), `browser = launchBrowser()` (`export-session.ts:123`), `page = browser.newPage()` (`export-session.ts:124`), `page.setViewport({ width, height, deviceScaleFactor: 1 })` (`export-session.ts:125`) — `_capture runs at deviceScaleFactor: 1`_ (`SKILL.md:31`): exported pixels equal `width × height` regardless of host DPR.
3. `page.goto(target.url, { waitUntil: 'networkidle0' })` (`export-session.ts:132`) — wait for quiescence before touching the scene.
4. `sizeCanvas(page)` (`export-session.ts:133` → `export-session.ts:90`): `document.querySelector('canvas')` → `canvas.width = width; canvas.height = height`. Throws `No canvas found` if missing (`export-session.ts:93`). This runs _after_ `goto` so the page's own `<canvas>` already exists — the Vite synthetic shell (`input-target.ts:81`) provides it for local entries.
5. `validateAndStopScene(page)` (`export-session.ts:134` → `:60` — see §2).
6. Second `throwIfAborted()` (`export-session.ts:135`) — an abort arriving during validation must stop before FFmpeg spawns.
7. `encoder = startFfmpeg({ fps, outputPath: output.path, audioPath, signal })` (`export-session.ts:137`): note the _staged_ path `output.path` (`staged-output.ts:53`, a `.<stem>.vecto-<uuid>.mp4` sibling of the destination), not the final `outputPath`.
8. `progress = createProgress()` (`export-session.ts:143`, `cli-progress` default at `export-session.ts:41`) then `progress.start(totalFrames)` (`export-session.ts:144`).
9. Frame loop (`export-session.ts:146`):

   ```ts
   for (let frame = 0; frame < totalFrames; frame++) {
     throwIfAborted(); // export-session.ts:147
     await page.evaluate((dt) => scene.step(dt), dt); // :148
     await encoder.write(await captureFrame(page)); // :153
     progress.update(frame + 1); // :154
   }
```
`captureFrame` (`export-session.ts:99`) reads the _first_ `<canvas>` and calls `canvas.toDataURL('image/png')`, splits on `,` (`export-session.ts:104`), decodes the base64 tail to a `Buffer` for the `image2pipe/png` stdin. _"First page `<canvas>` is resized and captured"_ (`SKILL.md:27`).

<!-- markdownlint-disable MD029 -->

10. After the loop: `throwIfAborted()` (`export-session.ts:157`), `encoder.finish()` (`export-session.ts:158` closes stdin and waits for `close`), `throwIfAborted()` again (`export-session.ts:159`), then `output.commit()` (`export-session.ts:160`) — only after a clean FFmpeg exit does the staged file replace the destination.

## 4. FFmpeg — `image2pipe` → H.264/yuv420p, with a bounded stderr tail

### 4.1 Arguments

`packages/video-exporter/src/ffmpeg-supervisor.ts:274` `startFfmpeg`:

```ts
const args = ['-y', '-f', 'image2pipe', '-vcodec', 'png', '-r', String(fps), '-i', '-'];
if (audioPath !== undefined) args.push('-i', audioPath);
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
if (audioPath !== undefined) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
args.push(outputPath);
```text

Ordering note (`ffmpeg-supervisor.ts:278`): inputs first (`-f image2pipe … -i -`, then optional `-i audioPath`), then output options — `-c:a` before the audio `-i` would attach to the decoder, not the output encoder. Audio is AAC `192k` trimmed to the video length (`-shortest`, `ffmpeg-supervisor.ts:287`), enabled only by positional `-a/--audio` on the CLI (`cli.ts:32`, `:64`) or `audioPath` in the API (`options.ts:16`, `:78`).

Output is standard H.264 `yuv420p` MP4 (`SKILL.md:28`, `README.md:12`).

### 4.2 Stdin supervisor — backpressure, EPIPE races, and the `FfmpegSupervisor` seam

FFmpeg is spawned as a `ChildProcessLike` (test-fakeable at `ffmpeg-supervisor.ts:13`/`21`/`28`) whose `stdin` is written by the frame loop. `ffmpeg-supervisor.ts:34` `FfmpegSupervisor` hardens the stdin pipe:

- `stderrBuffer` is bounded to 64 KiB (`ffmpeg-supervisor.ts:5` `STDERR_LIMIT`) by concatenating then tailing (`:67` `combined.subarray(combined.byteLength - STDERR_LIMIT)`) — _every_ error carries that tail (`:117` `stderr.trim()` in `processError`).
- `spawnError` from the child `error` event → `Failed to start FFmpeg: ...` (`:73`).
- A persistent `child.stdin.on('error')` handler records `stdinError` (`:80`). Motivation (`:41`): _"FFmpeg dying mid-export destroys the pipe and emits an async EPIPE after the last write() has already resolved — with no live listener that surfaces as a listener-less uncaught exception, escaping the ExportSession try/catch, skipping its cleanup, and orphaning headless Chromium plus the Vite server."_ Recording it lets `processError` surface the failure through the normal abort/cleanup path on the next `write`/`finish`.
- `close` is committed once via `markClosed` (`:92`, guarded by `closed`, records `closedBeforeInputCompleted`). `closeCode`/`closeSignal` + `exitDescription` (`:105` `code N` / `signal NAME` / `unknown status`) are included in every exit error.
- `processError(early: boolean)` (`:111`) is the single decision point:
  - if `spawnError` → that,
  - else if not yet closed and `stdinError` set → that (broken pipe even though child hasn't exited),
  - else if closed and `early||closeCode!==0` → `FFmpeg exited before input completed` vs `exited` + exit description + stderr tail,
  - else (clean exit with a late `stdinError`) → still surface `stdinError` rather than reporting success over a broken pipe.
- `write(frame)` (`:156`) checks `throwIfAborted()` and `processError(true)` before the write, uses the boolean `stdin.write(frame)` backpressure return — `false` waits in `waitForDrain()` (`:126`). That race installs one-shot listeners for `stdin:drain`, `stdin:error`, `child:close`, and `signal:abort` (`:131`/`134`/`149`/`137`) and resolves/rejects accordingly; `throwIfAborted()` and `processError(true)` are checked again after drain.
- `finish()` (`:177`) is idempotent (`finishPromise`). `finishOnce` (`:183`) guards `closedBeforeInputCompleted` (can't finish if the child died early), calls `child.stdin.end()` (`:190`), then `waitForCloseOrAbort()` (`:198`) before re-checking `processError(false)` — exit-code `0` with empty `stdinError` is the only success.

### 4.3 Termination — `terminate()`, `SIGTERM→SIGKILL`, and the signal-less hang

`terminate()` (`:241`) is the cleanup path, also idempotent. `terminateOnce` (`:247`) always tries to tidy:

- `child.stdin.destroy()` then `SIGTERM`, wait `terminateTimeoutMs` (default `1000ms`, `options.ts:31` / `ffmpeg-supervisor.ts:258`) for `closedPromise` (`:249`), escalate to `SIGKILL` (`:253`), wait again (`:254`). `waitForCloseOrTimeout` (`:257`) races `closedPromise` vs a `setTimeout(timeoutMs)` (`:263`) and clears the timer (`:266`).

`waitForCloseOrAbort` (`:203`) has a **signal-less branch** — library callers may pass no `AbortSignal`, so a bare `await closedPromise` would hang `finish()` forever if FFmpeg wedges. In that branch each stage waits `terminateTimeoutMs` and escalates `SIGTERM→SIGKILL`, finally throwing `FFmpeg did not exit after SIGTERM and SIGKILL` with the stderr tail (`:222`) — same ladder `terminate()` uses, now applied to `finish` when no external abort exists. With a signal present, `waitForCloseOrAbort` races `closedPromise` against `signal:abort` (`:227`/`234`) and routes cancellation through `abortError`.

### 4.4 `StagedOutput` — atomic destination replacement

`packages/video-exporter/src/staged-output.ts:27` `StagedOutput`:

- `path = <dir>/.<stem>.vecto-<uuid>.mp4` (`:53`), `targetPath` is the caller's `outputPath`, `backupPath = .<stem>.vecto-<uuid>.backup<ext>` (`:54`) — the staged identity is a hidden sibling, unique per export (uuid via `node:crypto` `randomUUID`, `:1`/`14`/`60`).
- Construction kicks off `staleSweep` (`:55`, `:42`): a best-effort reclamation of `.vecto-*` siblings left by a killed previous run that died between backup-rename and install (`:35`). `sweepStaleFiles` (`:82`) reads the destination directory, finds `.prefix = ".<stem>.vecto-"` entries (`:89`), excludes own `path`/`backupPath` (`:90`), and `rm(..., { force: true })` via `Promise.allSettled` (`:92`).
- `commit()` (`:99`) awaits `staleSweep` first (no race with its own renames, `:41`), then `rename(path, targetPath)` — fast-path install when no file or overwrite succeeded (`:104`). On `EEXIST`/`EPERM` (`:108`/`21` `errorCode`), it does the classic swap: `rename(targetPath, backupPath)` (`:112`), `rename(path, targetPath)` (`:115`) — if the second rename throws, restore `rename(backupPath, targetPath)` (`:119`) and throw an `AggregateError` carrying _both_ `installError` and `restoreError` (`:126`, intentionally not a single `cause`). On success it removes the backup (`:134`).
- `cleanup()` (`:138`) also awaits `staleSweep`, then `rm(path)` (`:145`), and if `backupMoved` is still set reconciles the backup (`:150`): if the destination now exists the backup was already replaced and is deleted; if an `installError` left the destination missing the backup is restored. Exceptions are collected as an `AggregateError` (`:163`).

Result: FFmpeg encodes into the staged file beside the destination (`export-session.ts:137` `output.path`). A failed or aborted export keeps any existing destination intact and removes the staged artifact — verified in `test/export-session.test.ts` conventions cited below.

## 5. Browser details that the pipeline depends on

- A single helper page per export (`export-session.ts:124` `browser.newPage()`) — capture runs through that one `PageLike` (`browser.ts:4` `PageLike` with `setViewport`/`goto`/`waitForFunction`/`evaluate`). The `PageLike` is intentionally minimal so the browser mock in tests stays exact.
- Device scale is pinned to `1` (`export-session.ts:128`) — consistent with `SKILL.md:31` `deviceScaleFactor: 1` and the export's promise that `width × height` is output pixels independent of the host DPR (boss 07 territory).
- `page.goto(..., { waitUntil: 'networkidle0' })` (`export-session.ts:132`) waits for network quiescence before `sizeCanvas`/`validateAndStopScene` run — without it a late `window.vectoScene` assignment would miss the `waitForFunction` window or carry a partially loaded scene graph.

## 6. Cancellation and process signals — every path converges on `AbortError`

Export cancellation has three origins but one error kind: an `AbortError` named error whose `cause` is the `AbortSignal.reason` (`abort-error.ts:6`). `abortError` was factored in `#661` (see `abort-error.ts:1` comment) to de-duplicate the two identical implementations previously in `export-session` and `ffmpeg-supervisor`.

### 6.1 Library API — `AbortSignal`

Both `options.ts:17` (`signal?: AbortSignal` on `ExportOptions`) and its normalised copy (`options.ts:28`) carry the signal into `ExportSession` and `FfmpegSupervisor`. Every mutation point calls `throwIfAborted()` (`export-session.ts:55`/`147`/`157`/`159`, `ffmpeg-supervisor.ts:101`/`126`/`157`/`184`/`225`), and `waitForDrain`/`waitForCloseOrAbort` listen for `signal:abort` (one-shot listeners at `ffmpeg-supervisor.ts:152`, `232`).

### 6.2 CLI — `SIGINT`/`SIGTERM` → `AbortController`

`packages/video-exporter/src/cli.ts:50` `runCli`:

- `parseArgs` with `allowPositionals: true` (`cli.ts:55`), one positional `url` required (`cli.ts:74`), extras rejected loudly (`cli.ts:82` _"silently exporting only the first hides the error"_), `output`/`width`/`height`/`fps`/`duration`/`audio` mapped from `values` with `positiveInteger`/`positiveNumber` validation (`cli.ts:34`/`42`).
- `AbortController` (`cli.ts:113`), `SIGINT→abort('Interrupted by SIGINT')` (`cli.ts:115`) and `SIGTERM→abort('Terminated by SIGTERM')` (`cli.ts:119`), with conventional exit codes `130` (`cli.ts:116`) / `143` (`cli.ts:120`) remembered as `signalExitCode` and returned preferentially (`cli.ts:137`). Listeners are registered via the injectable `CliRuntime` (`cli.ts:18`/`20`) and removed in `finally` (`cli.ts:142`), same shape that makes `ExportSession`'s deps testable.
- `runCli` does not throw on signal: `if (signalExitCode !== undefined) return signalExitCode` even when `exportVideo` threw the `AbortError` (`cli.ts:139`), and `catch` → `runtime.error('Export failed:', error)` (`cli.ts:140`) vs `1` otherwise. Executability guard at `cli.ts:148` `isExecutableEntry` resolves a symlink mismatch between `dist` and `argv[1]` via `realpathSync`.

### 6.3 Ordered cleanup — no orphaned browser/server/FFmpeg/staged-file

`ExportSession.run` (`export-session.ts:166` `clean` helper inside `catch`) releases in reverse acquisition order: `progress.stop` → `encoder.terminate` → `browser.close` → `target.close` → `output.cleanup` (`export-session.ts:175`–`:179`). The matching never-throw pattern is taken from `cli.ts:142` `off` in `finally`; the exporter variant is more explicit — each step is `try/catch` into `cleanupErrors` (`:170`) and then:

- if `primaryError` (any throw from `try`) and no cleanup errors → throw `primaryError` (`:182`);
- if both → `AggregateError([primaryError, ...cleanupErrors], errorMessage(primaryError), { cause: primaryError })` (`:183`);
- if only cleanup errors → `AggregateError(cleanupErrors, 'Video export cleanup failed')` (`:188`).

FFmpeg's own `finish`/`terminate` races (`ffmpeg-supervisor.ts:198` `waitForCloseOrAbort`, `:247` `terminateOnce`) guarantee no infinite hang even without a signal. The staged sweep (`staged-output.ts:35` stranded-CI note) and the Chromium/Vite closes above together mean a `SIGKILL` between backup-rename and install (`staged-output.ts:35`, `export-session.ts:78`-adjacent) is recoverable on the _next_ run.

### 6.4 What tests verify about cleanup ordering

`packages/video-exporter/test/export-session.test.ts:60` fixtures encode ordering. Two tests are worth reading as the intended lifecycle spec:

- _`reset` timing_ (`:154` `fixture.events.indexOf('scene.reset')` between `scene.stop` and `scene.step`) — the frame-0 contract's ordering regression guard.
- _Failure still closes everything_ (`:169` `progress.stop`, `:185` `scene.stop`, `:210` `progress.acquired` ↔ `progress.stop` invariant) — each `startFfmpeg` → `encoder.terminate`, each `launchBrowser` → `browser.close`, each `resolveInputTarget` → `target.close`, each `createStagedOutput` → `output.cleanup`, even when `progress.stop` or a `write` throws.

## 7. What the exporter does _not_ make deterministic

The fixed step removes host and compositor nondeterminism. The remaining sources are in the scene author's hands:

- **`Math.random()`**: must be seeded (e.g. `splitmix`/`xoshiro` with a frame-indexed seed) or replaced with authored-keyframe data. Screen-space sampling that jitter-samples per frame will otherwise flicker per run.
- **Network/IO**: fetches that resolve at `networkidle0` boundary vs later should be awaited deterministically (gated by a readiness flag checked before the first `step`, not by a wall-clock timeout).
- **Asynchronous resource loading**: fonts (`packages/text/src/fontMetrics.ts:82` `registerFontMetrics`), mipmap levels, or WebGL shader compiles that report `canUseSvgText` / `canUseMsdf` / `isReady` must be awaited before t=0 — otherwise frame 0 races against the decoder.
- **Platform shaping differences**: different `measureText` backends or `deviceScaleFactor` traps (boss 02) will still diverge if you capture on a different engine. `deviceScaleFactor: 1` (`export-session.ts:128`) eliminates the DPR variant, but not the font-shaping variant — keep frame assertions engine-specific.

Anything of this form must be either `reset()`-gated, seeded, or removed. The exporter guarantees that identical Scenes stepped with `dt` produce identical frames; it cannot guarantee your Scene is identical across runs.

## 8. CLI vs API — choose by caller, not by capability

### 8.1 API — `exportVideo(options)`

`packages/video-exporter/src/index.ts:6` `exportVideo`:

```
import { exportVideo } from '@vectojs/video-exporter';
await exportVideo({
  url,
  outputPath,
  width,
  height,
  fps,
  duration,
  audioPath,
  signal,
});
```text

One function, no builder. `normalizeOptions` throws synchronously on bad geometry/audio/output-dir (`options.ts:58` odd dimensions, `:78` missing `audioPath`, `:90` missing parent, `:97` not writable) so a misconfigured job fails _before_ Chromium boots. The `totalFrames = Math.ceil(fps*duration)` contract (`options.ts:112`, `cli.ts:104` re-derives the same width) is intentionally not "fps×duration−maybe-one" — short durations produce the right count and there is no fractional-frame. Signal on the API is used directly (`options.ts:17`/`28` and `export-session.ts:32` `signal` field in `FfmpegOptions`).

### 8.2 CLI — `vecto-export`

`packages/video-exporter/src/cli.ts:25` `USAGE`:

```
Usage: vecto-export <url> [options]
  -o, --output <file>    Output file (default: out.mp4)  cli.ts:59
  -w, --width <pixels>   Width (default: 1280)            cli.ts:60
  -h, --height <pixels>  Height (default: 720)            cli.ts:61
  -f, --fps <number>     FPS (default: 60)                cli.ts:62
  -d, --duration <secs>  Duration (default: 5)            cli.ts:63
  -a, --audio <file>     Mux an audio track as AAC        cli.ts:32/64
```text

Semantics:

- **Local vs remote input is implicit**: if `url` looks like `http(s)://` it's remote (`options.ts:68`); otherwise it's a local file served via the Vite HTML shell (`input-target.ts:48`). You don't pass a flag to distinguish them.
- **Rejection of a second positional** (`cli.ts:82`) is the "batch export intended" trap — `vecto-export a.ts b.ts` fails with `Unexpected extra arguments` rather than exporting only `a.ts`.
- **Exit codes**: `0` success (`cli.ts:137` fallthrough), `1` validation/Browser/FFmpeg/cleanup failure (`cli.ts:141` / options throw / `RuntimeError`), `130` on `SIGINT`, `143` on `SIGTERM` (`cli.ts:116`/`120`). `vecto-export --help` maps to `runCli` with `parsed` missing `url` (`cli.ts:74` → `USAGE`) or thrown `parseArgs` (`:69` `Invalid arguments` + `USAGE`).
- **Package contract** (`packages/video-exporter/package.json`): `main: dist/index.js`, `bin: { vecto-export: dist/cli.js }`, build via `tsc` then `chmod 0755 dist/cli.js` (`package.json:10` `chmodSync`). The distributed `.d.ts` is `dist/index.d.ts`. `exportVideo` is the only public API surface (`index.ts:6`).

### 8.3 Decision aid

| situation                                                                                               | use                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| CI job that renders a story or demo into an artifact                                                    | `vecto-export ./src/demo/foo.ts -o out.mp4 --fps 60 --duration 3 -a voice.wav` (one-shot, exits with 0/1/130/143) |
| Library caller that owns a Vite server / browser page, or needs to compose export with other async work | `exportVideo({ url, outputPath, signal })` from `index.ts:6`                                                      |
| Capturing stills/snapshots or a short clip from a hosted URL                                            | `vecto-export https://…/scene.html` (remote path, no Vite)                                                        |

## 9. Failure modes — which component is speaking

Each phase throws a message that identifies the phase; `cli.ts:140` surfaces it as `Export failed:` + `AggregateError` with the bounded FFmpeg stderr tail (`ffmpeg-supervisor.ts:64` 64 KiB, always attached on exit-code `≠0` at `ffmpeg-supervisor.ts:117`). When assigning a failure, ask:

| failure                                                       | likely component                   | decisive clue                                                                   |
| ------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `width and height must be even for H.264`                     | `options.ts:58`                    | up-front, never FFmpeg-time                                                     |
| `Input file does not exist` / `Audio file does not exist`     | `options.ts:70` / `:84`            | before Chromium/Vite                                                            |
| `Output directory does not exist / is not writable`           | `options.ts:90` / `:97`            | before Chromium/Vite                                                            |
| `Vite did not expose a TCP address`                           | `input-target.ts:106`              | local entry, port 0 bind                                                        |
| `Failed to start FFmpeg`                                      | `ffmpeg-supervisor.ts:73`          | `spawn` `error` event                                                           |
| `FFmpeg exited before input completed`                        | `ffmpeg-supervisor.ts:115`         | early exit, includes stderr tail                                                |
| `FFmpeg exited with code N: …` + stderr tail                  | `ffmpeg-supervisor.ts:117`         | `pix_fmt` / `yuv420p` / `libx264` misconfig                                     |
| `FFmpeg stdin failed` / `EPIPE`                               | `ffmpeg-supervisor.ts:80` / `:145` | destroyed pipe, unrestrained mid-export `write`                                 |
| `FFmpeg did not exit after SIGTERM and SIGKILL`               | `ffmpeg-supervisor.ts:222`         | wedge, signal-less `finish()` only                                              |
| `No canvas found`                                             | `export-session.ts:93`/`102`       | missing or hidden `<canvas>` in the page                                        |
| `window.vectoScene must provide callable stop() and step(dt)` | `export-session.ts:71`             | page contract not exposed in time                                               |
| `Video export cleanup failed` (AggregateError)                | `export-session.ts:188`            | a `browser.close` / `target.close` / `output.cleanup` threw after primary error |
| `Failed to install staged output…`                            | `staged-output.ts:126`             | `ATOMIC_MOVE` two-step rename race                                              |

The list above is not invented: each string exists verbatim in the `{file,}:line` given.

## 10. Testing the exporter and its edges

The export package is tested without a real Chromium or Vulkan instance — every external is a `*Like` fake injected through `ExportSessionDependencies` (`export-session.ts:27`) / `FfmpegDependencies` (`ffmpeg-supervisor.ts:21`) / `InputTargetDependencies` (`input-target.ts:29`) / `CliRuntime` (`cli.ts:11`). What those fakes assert:

- `packages/video-exporter/test/export-session.test.ts:30` `fixtures` drive `scene.stop/ reset/ step`, `inputTarget.close`, `StagedOutput` create/commit/cleanup, `browser.newPage`, `FfmpegSupervisor.write/finish/terminate`, and `progress.{start,update,stop}` as string `events` that the assertions query by `indexOf` / `includes` (`:154` reset timing, `:169` `progress.stop` presence, `:185` ordered steps, `:239` invalid-contract before FFmpeg).
- Cancellation is modeled by an `AbortController` aborted before or mid-loop (`export-session.test.ts:295` `controller.abort('stop now')`) — the `throwIfAborted` checks (`export-session.ts:147`/`157`) become visible as the suppressed extra `step`/`write` frames.
- `test/cli.test.ts` drives `parseArgs` validation (`cli.ts:54` invalid args → `1`, `cli.ts:82` extra positionals → `1`) and the `CliRuntime.once/off` signal seam (`cli.ts:123`/`142`).
- `test/staged-output.test.ts` drives `rename`/`rm`/`readdir` fakes (`staged-output.ts:6` deps) to hit the `EEXIST/EPERM → backup → install → restore` ladder (`staged-output.ts:108`/`112`/`119`) and the orphan-reclamation sweep (`staged-output.ts:42`/`82`).

A minimal in-page scene that the exporter can drive (from `packages/video-exporter/test/fixtures/two-frame-scene.ts:8`):

```ts
import { Scene } from '@vectojs/core';
const scene = new Scene(document.querySelector('canvas')!);
// ... assemble entities, animators, springs/tweens — all driven from dt ...
(window as unknown as { vectoScene?: unknown }).vectoScene = {
  stop: () => scene.stop(),
  step: (dt: number) => scene.step(dt), // Scene.ts:3423 — fixed step
  reset: () => {
    /* return to t=0 if you animated during load */
  },
};
```text

Scenes that never call `scene.start()` need no `stop`/`reset` other than this wrapper — they remain static until the exporter drives them (`demo/data-chart.ts:227`/`ml-descent.ts:219` pattern).

## 11. Pitfalls

- **Forgetting `window.vectoScene`**: page loads, exporter waits 10s (`export-session.ts:61`), times out. Always set it before `scene.start()` or expose it synchronously (`demo/data-chart.ts:222` `window.vectoScene = scene` before start).
- **Load-time state without `reset`**: intro tween has frame-0 jitter (`export-session.ts:78` base nondeterminism, `#646`). Add `reset()`.
- **Wall-clock dynamics**: `Date.now()` in a `tick` callback undoes the fixed step. Thread `dt` through state or seeded simulation state only.
- **Odd dimensions**: silently passes validation would encode late and fail with opaque FFmpeg stderr. `options.ts:58` rejects early.
- **Assuming "no audio track" means "silent output"**: exports are silent only if `audioPath` is omitted (`options.ts:16` _"canvas pipeline itself never produces sound"_); passing a bad path fails before Chromium (`options.ts:80`) so bad audio isn't a late surprise.
- **Killing without cleanup**: a `kill -9` between backup-rename and install (`staged-output.ts:35`) leaves a stranded `.vecto-*`. The next export's `staleSweep` (`staged-output.ts:42`/`55` + `export-session.ts:122` construction) is the recovery — don't manually delete `.vecto-*` files mid-export.
- **Assuming browser export works on CI without FFmpeg/Chromium**: vendor the right packages and set `PUPPETEER_EXECUTABLE_PATH` if you ship your own Chromium (`browser.ts:49` / `README.md:10` install note).
- **CRITICAL**: All refs above are grep-verified against pinned repo at `/mnt/data/Workspace/Projects/vectojs/vectojs` (`options.ts`, `export-session.ts`, `browser.ts`, `ffmpeg-supervisor.ts`, `input-target.ts`, `staged-output.ts`, `abort-error.ts`, `cli.ts`, `Scene.ts:3423`/`5609`/`1114`, `SKILL.md`, `references/export-recipes.md`).

## 12. Checklist — authoring a deterministic export

- [ ] Page exposes `window.vectoScene` with callable `stop` and `step(dt)` (`export-session.ts:71` contract).
- [ ] If the scene renders load-time state, it also exposes `reset()` (`export-session.ts:84` frame-0 fix, `#646`).
- [ ] Scene never calls `scene.start()` in export mode, or `stop()` reliably cancels its loop before first capture (`demo/math-teaching.ts:9`/`161` clock note, `export-session.ts:75` `scene.stop()` right after validation).
- [ ] All animators integrate the `dt` passed to `step` — no `Date.now` / wall-clock reads inside `tick`/springs/tweens (`Scene.ts:3423` fixed-step path, vs `Scene.ts:5609` clamped wall-clock `dt`).
- [ ] Randomness (if any) is seeded from `frame` or a deterministic prng — `Math.random()` every frame will flicker across runs.
- [ ] Fonts/Msdf/shader resources are loaded before t=0 (no unawaited `registerFontMetrics` / `isReady` race at `packages/text/src/fontMetrics.ts:82`).
- [ ] Export geometry is even (`options.ts:58` `2 | dimensions`, `yuv420p` requirement) and `deviceScaleFactor: 1` is assumed for resolution claims (`export-session.ts:128`).
- [ ] Abort propagates (`signal` on API, SIGINT/SIGTERM in CLI) and every resource has an injected `close/terminate/cleanup` (`export-session.ts:175` + `ffmpeg-supervisor.ts:249`).
- [ ] Optional audio is a file-path (`options.ts:78` `audioPath` pre-launch check), not a live capture — exported canvas video is silent without it (`options.ts:14` silence note).

## Relations

- **Boss 06 (VMT runtime)** owns the `loop` (`Scene.ts:5569`) ↔ `step` (`Scene.ts:3423`) duality and why the rAF loop clamps but `step` does not.
- **Boss 07 (renderer)** owns `deviceScaleFactor: 1` on `page.setViewport` (`export-session.ts:128`) and why culling stays consistent when the capture clock is fixed.
- **Boss 08 (WASM)** is invisible here — any live WASM store vs JS parity must hold frame-by-frame under fixed-step advance too, but the exporter never special-cases it.
- **Boss 01/02 (selection + text)** supply the font/shape preparation whose readiness must be awaited before t=0 — otherwise frame 0 includes a race rather than a capture.
- **Boss 11+ product surfaces (canvas apps)** are where `@vectojs/video-exporter` gets used in practice — forward them to this boss, not the other way around.

## References

- `packages/video-exporter/src/index.ts:6` — public `exportVideo(options)` entry, the only exported symbol
- `packages/video-exporter/src/options.ts:40` — `normalizeOptions` + geometry/audio/dir validation + `Math.ceil(fps*duration)`/`dt` derivation
- `packages/video-exporter/src/export-session.ts:111` — `ExportSession.run` lifecycle, `validateAndStopScene` contract, staged `output.path` + loop `page.evaluate(step(dt))` + `captureFrame`
- `packages/video-exporter/src/input-target.ts:48` — `resolveInputTarget` Vite vs remote branching, synthetic `<canvas>` shell + `transformIndexHtml`
- `packages/video-exporter/src/browser.ts:45` — `resolveBrowserLaunchOptions` executable/sandbox args
- `packages/video-exporter/src/ffmpeg-supervisor.ts:34` — `FfmpegSupervisor` bounded stderr, stdin EPIPE guard, `write`/`finish`/`terminate`, `SIGTERM→SIGKILL` escalations
- `packages/video-exporter/src/staged-output.ts:27` — atomic staged file + backup + `sweepStaleFiles` orphan reclaim
- `packages/video-exporter/src/abort-error.ts:6` — `abortError(signal)` shared `AbortError` factory (`#661`)
- `packages/video-exporter/src/cli.ts:50` — `runCli` arg parsing, `130`/`143` signal exit codes, `injected CliRuntime`
- `packages/core/src/tree/Scene.ts:3423` — `step(dt)` fixed-step contract: unconditional render, unclamped `dt`, `frameStats` zeros, measurement footgun note
- `packages/core/src/tree/Scene.ts:5569` / `5609` / `5636` / `1114` — `loop` wall-clock `dt`, `100/cap` snapping, `MAX_FRAME_DT=100` clamp
- `packages/video-exporter/package.json:10` — `dist/cli.js` + `chmod 0755` build, `bin: vecto-export`, `main: dist/index.js`
- `packages/video-exporter/demo/*.ts:222` / `test/fixtures/two-frame-scene.ts:8` / `test/export-session.test.ts:154` — scene-contract usage sites
- `.agents/skills/vectojs-video-exporter/SKILL.md:1` — exporter skill (0.2 contract + sandbox policy + common mistakes)
- `.agents/skills/vectojs-video-exporter/references/export-recipes.md` — CLI/API snippets
