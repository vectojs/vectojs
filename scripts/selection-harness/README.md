# Selection harness

Real-hardware driver for the `@vectojs/devtools` **selection-overlap audit**
(`auditSceneSelection`): does the transparent DOM content projection — what the
browser lets a user drag-select and copy — sit exactly on top of the glyphs the
canvas drew? Drift means the highlight slides off the text and copy grabs the
wrong characters. The classic causes are justified lines (widened inter-word
gaps), RTL/bidi (visual reorder + right-align), and fractional DPR/zoom rounding.

The **audit itself lives in `@vectojs/devtools`** (browser-side, authoritative
projection geometry, no OS deps) so apps can run it against their own scenes.
This harness is only the QA driver: it serves a surface page, launches a **real**
Chrome/Firefox foregrounded on a dedicated Hyprland workspace (isolated profile,
never touches your browser), lets the page self-report the audit as JSON, and
grabs a `grim` screenshot. Real hardware is the point — the drift sources only
appear in a real browser at a real scale, never headless.

## Run

```bash
# 1. Build a surface page (bundles a surface + the harness, aliases @vectojs/* → src)
bun scripts/selection-harness/build.ts scripts/selection-harness/surfaces/text-surfaces.ts

# 2. Drive it on a real browser (workspace 3 by default). DPR/ZOOM via env.
scripts/selection-harness/drive.sh chrome  scripts/selection-harness/page 8210 out.png out.json
DPR=1.5 ZOOM=0.9 \
scripts/selection-harness/drive.sh firefox scripts/selection-harness/page 8210 out.png out.json
```

`out.json` is `{ engine, dpr, clean, findings }`. `clean: true` (empty
`findings`) means every selection box tracks its glyphs. Each finding names the
entity + line and the left/right drift in local logical px.

## Add a surface

Copy `surfaces/text-surfaces.ts`: mount your entities on a `Scene`, then
`reportSelectionAudit(scene)`. The devtools audit walks every selectable
projection, so the surface stays trivial. `?zoom=` applies CSS zoom.

## Layers

- `surfaces/*.ts` — a mounted scene + `reportSelectionAudit`. Add one per case.
- `harness.ts` — thin reporter: runs `auditSceneSelection`, POSTs `/results`,
  paints an on-page `<pre>` for the screenshot.
- `build.ts` — bundle a surface → `page/index.html` (gitignored).
- `serve.ts` — loopback static + `/results` collector.
- `drive.sh` — launch a real browser (either engine, any DPR/zoom), focus it,
  wait for the JSON, screenshot, return home.

`page/` and `results/` are gitignored build/run output.
