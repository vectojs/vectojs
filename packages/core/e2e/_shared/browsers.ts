/**
 * Shared browser-resolution helpers for the e2e ink gates.
 *
 * Six suites across `packages/core` and `packages/markdown` had independently
 * grown the same engine-resolution code. Measured before extracting: the
 * `BrowserCase` interface and the 22-line `[chromium, firefox]` array were
 * **byte-identical** (md5 `903fa24e` and `ce838d28`) in `svg-fallback`,
 * `msdf-atlas-decode`, `lazy-math`, `blockquote-layout` and
 * `stream-controller`, and `layout-worker-fallback` differed from the array
 * only by the name of the local it assigns to. `executable()` existed in two
 * spellings that are behaviorally identical — `candidate &&` and
 * `candidate.length > 0` agree for every string — differing only in the throw
 * message.
 *
 * `benchmarks/_shared` is the precedent for having this layer at all
 * (`AGENTS.md`: "The server and bundler live in `benchmarks/_shared/` — do not
 * create per-benchmark copies"), but it is a *structural* precedent only: it
 * uses `Bun.build`/`Bun.serve`, while the e2e suites use `esbuild` + `node:http`.
 *
 * Deliberately NOT shared, because each is load-bearing per suite:
 *
 * - **Ink counting.** All four ink suites sample differently — `svg-fallback`
 *   insets 1px inside the helper, `layout-worker-fallback` does not inset but
 *   clamps to the canvas bounds, `lazy-math` has the caller inset, and
 *   `msdf-atlas-decode` reads a WebGL2 framebuffer bottom-up. Unifying them
 *   would move the sampled region, and `svg-fallback` asserts *exact* ink
 *   equality between two cases, so a shifted region would break a real
 *   assertion rather than merely changing a number.
 * - **The per-engine loop.** `layout-worker-fallback` deliberately runs both
 *   engines even after one fails, then throws a count; the others exit at the
 *   first failure. `msdf-atlas-decode` additionally needs *skipped* to be
 *   distinct from *passed* to keep its "no engine provided WebGL2" guard
 *   honest.
 * - **Frame pacing.** The poll counts are tuned per defect and are not
 *   interchangeable: `msdf-atlas-decode` documents *not* using rAF because
 *   headless throttles it to ~2 ticks per 550ms, which is the opposite of the
 *   choice `lazy-math` makes.
 *
 * This module intentionally imports nothing but `node:fs`, so it stays usable
 * from any package's `e2e/` regardless of whether that package declares
 * `esbuild` (five do; the repo root does not).
 */
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';

/** One engine under test, resolved to a concrete executable on this machine. */
export interface BrowserCase {
  name: string;
  browser: 'chrome' | 'firefox';
  executablePath: string;
}

/**
 * First existing path among `candidates`.
 *
 * The message lists what was tried, which is the more useful of the two
 * spellings this replaced — the other said only "Set its *_EXECUTABLE_PATH
 * environment variable".
 */
export function executable(candidates: string[], label: string): string {
  const path = candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
  if (!path) throw new Error(`No ${label} executable found (${candidates.join(', ')})`);
  return path;
}

/**
 * Chromium and Firefox, in that order.
 *
 * Resolution order per engine matches what every suite already did:
 * `PUPPETEER_EXECUTABLE_PATH` → `/usr/bin/chromium` → `/usr/bin/google-chrome`,
 * and `FIREFOX_EXECUTABLE_PATH` → `/usr/bin/firefox`. CI supplies the Firefox
 * path from `browser-actions/setup-firefox`.
 *
 * Throws if either engine is missing, which is the existing behavior: a gate
 * that silently ran one engine would be a gate that stopped covering the other.
 */
export function bothEngines(): BrowserCase[] {
  return [
    {
      name: 'chromium',
      browser: 'chrome',
      executablePath: executable(
        [
          process.env.PUPPETEER_EXECUTABLE_PATH ?? '',
          '/usr/bin/chromium',
          '/usr/bin/google-chrome',
        ],
        'Chromium',
      ),
    },
    {
      name: 'firefox',
      browser: 'firefox',
      executablePath: executable(
        [process.env.FIREFOX_EXECUTABLE_PATH ?? '', '/usr/bin/firefox'],
        'Firefox',
      ),
    },
  ];
}

/**
 * Close a fixture server and wait for it, surfacing a close error.
 *
 * Worth sharing rather than inlining: a bare `server.close()` is not awaited,
 * so the process can exit with the listener still open and a close error
 * silently dropped.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
