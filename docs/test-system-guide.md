# VectoUI Testing Guide

A practical, data-driven testing guide for the **engine repo** (`@vecto-ui/core`,
`@vecto-ui/ui`). VectoUI's case rests on reproducible numbers, not reputation —
every claim in the README maps to a script or test here.

Demos, the docs site, and the marketing benchmark dashboard live in the separate
[vecto-website](https://github.com/Xuepoo/vecto-website) repo; this guide covers
only the engine's own QA.

---

## 1. Test layers

| Layer                      | Tooling                               | Where                                                 |
| -------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Unit & integration         | Vitest (jsdom)                        | `packages/core/test`, `packages/ui/test`              |
| Render benchmark           | Playwright + headless Chrome          | `scripts/benchmark.ts`, entry `benchmarks/bench.ts`   |
| vs DOM (framework compare) | Playwright + Chrome DevTools Protocol | `scripts/compare-dom.ts`                              |
| Text-layout accuracy       | Bun + ground-truth corpora            | `scripts/compare-pretext.ts`                         |
| a11y / agent automation    | Vitest jsdom + role/name contract     | `packages/ui/test/a11y-contract.test.ts`             |
| Stress / leak              | Vitest (50k–100k entities)            | `packages/core/test/stress.test.ts`                  |

Visual-regression (screenshot diff) and cross-browser matrices are deferred — they
need a screenshot baseline / multi-browser infra that is better hosted alongside
the demos in the website repo.

---

## 2. Unit & integration (Vitest)

Fast, dependency-free algorithm/logic verification. Core has ~25 test files, ui ~15.

```bash
bun run test                                        # core + ui (workspace filter)
cd packages/core && bunx vitest run                 # one package
cd packages/core && bunx vitest run test/SpringPhysics.test.ts   # one file
```

Conventions:

- Default environment is **node**; tests that need DOM put `// @vitest-environment jsdom`
  at the top (see `packages/ui/test/a11y-contract.test.ts`).
- Canvas is mocked, not polyfilled: tests stub `HTMLCanvasElement.prototype.getContext`
  with a `Proxy` (`fakeCtx`) whose `measureText` returns a deterministic width, so layout
  math is exact and reproducible without the native `canvas` package.
- For the layout engine, inject a `GlyphMeasurer` like `{ measure: (_c, fs) => fs * 0.5 }`
  so glyph widths are predictable (see `packages/core/test/prepareRich.test.ts`).

Representative suites: `SpringPhysics.test.ts` (damping ratios + a 50k-spring
single-frame budget), `LayoutEngine.test.ts` / `prepareRich*.test.ts` (cold/hot split,
paragraph memo), `exclusionFlow.test.ts` (text flow around rects), `stress.test.ts`
(50k entities, a11y churn, teardown leaks).

---

## 3. Render benchmark (real frame-time)

`scripts/benchmark.ts` drives headless Chrome via the globally-installed Playwright.
It serves and bundles **in-process** with `Bun.serve` + `Bun.build` (resolving
`@vecto-ui/core` to `packages/core/src` via a plugin) — no Vite child process — which
is what makes it CI/sandbox-safe. The page is `benchmarks/bench.ts`: it spawns N
entities, runs the real `Scene` render loop, and publishes results on
`window.__BENCH__` (and sets `window.__BENCH_DONE__`).

```bash
bun run benchmark                  # vsync-capped (CI/sandbox-safe; reports 60 fps sustainability)
bun run benchmark --uncapped       # true sub-16ms per-frame cost (adds --disable-frame-rate-limit)
bun run benchmark --n=100000 --world=4 --batch=1   # 100k, mostly off-screen (culling), batched draw
```

Knobs (URL/CLI): `n` (entity count), `frames`, `warmup`, `world` (k×viewport spread →
off-screen culling), `batch` (opt into the renderer's draw-call batching fast-path).
Record the numbers in the README table only from `--uncapped` runs, and note they are
per-machine.

---

## 4. vs DOM — Chrome DevTools Protocol metrics

`scripts/compare-dom.ts` runs an equivalent animation as both a VectoUI canvas scene
and a DOM implementation, and reads hard metrics over CDP (`Performance.getMetrics`):
`LayoutCount`, `LayoutDuration`, `JSHeapUsedSize`, `Nodes`. The point VectoUI makes:
a flat, near-constant DOM-node count with **0 layout / 0 style-recalc** while animating,
where the DOM equivalent thrashes layout every frame.

```bash
bun run compare:dom
```

CDP sketch (the script does this for you):

```typescript
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const before = await cdp.send('Performance.getMetrics');
// …run the animation…
const after = await cdp.send('Performance.getMetrics');
const m = (s, n) => s.metrics.find((x) => x.name === n)?.value ?? 0;
const layoutCount = m(after, 'LayoutCount') - m(before, 'LayoutCount');
```

---

## 5. Text-layout accuracy

`scripts/compare-pretext.ts` checks line-breaking and glyph positions against ground
truth / [pretext](https://vectomancy.xuepoo.xyz) on small corpora (incl. CJK). It
documents where VectoUI's `LayoutEngine` is on par and where it is not (bidi / complex
shaping remain a roadmap milestone — pretext/HarfBuzz go deeper).

```bash
bun run compare                    # set VECTO_PRETEXT_PATH if pretext is checked out elsewhere
```

---

## 6. a11y / agent automation contract

VectoUI's differentiator is the `a11yRoot` shadow layer: every interactive entity
projects a real, operable DOM node, so assistive tech **and** agents (Playwright / AI)
drive the canvas by role and name. `packages/ui/test/a11y-contract.test.ts` pins this:
correct role/name/state per primitive, live state reflected each frame, and
clicks/keystrokes round-tripping back into entity behavior.

In a real browser this is the same `getByRole(...).click()` an agent would use:

```typescript
const submit = page.getByRole('button', { name: 'Submit' });
await expect(submit).toBeVisible();
await submit.click(); // Playwright clicks the shadow node over the canvas
```

---

## 7. CI

`.github/workflows/ci.yml` runs on every branch push and PR to `main`:

1. `bun install`
2. core unit tests — `cd packages/core && bunx vitest run`
3. ui unit tests — `cd packages/ui && bunx vitest run`
4. lint — `bunx oxlint packages/core/src packages/ui/src`
5. build — `bun run build` for core then ui (tsup)

The headless benchmark / comparison scripts are **not** in CI (they need Chrome and are
machine-dependent); run them locally and paste numbers into PRs that affect performance.
Releases go through Changesets (`bunx changeset version`) + a manual per-package
`npm publish`; see `CONTRIBUTING.md`.
