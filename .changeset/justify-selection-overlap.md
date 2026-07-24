---
"@vectojs/core": minor
"@vectojs/ui": patch
---

Fix DOM text-selection drift on justified text. `ContentProjectionRun` gains optional `x` / `width`: when set, the Scene lays the run out as a positioned carrier (`inline-block` + relative `left`) at the exact canvas x, the same technique the code-grid path uses. `Text` now emits positioned per-word runs on justified lines, so the native selection highlight overlaps the widened canvas glyphs instead of drifting left under the browser's natural inter-word spacing (verified on real Chrome). Left-aligned text is unchanged (no positioned runs, natural flow).
