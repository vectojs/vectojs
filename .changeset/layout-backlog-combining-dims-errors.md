---
'@vectojs/layout': minor
---

Backlog: honest buffer dimensions, unknown-font signaling, hyphen measurement gating, dead-field removal (#653)

- **Removed the never-written `combining` field** from `LayoutNode` and
  `PreparedGlyph`. It was declared and copied but assigned nowhere, implying a
  cluster-attachment capability that does not exist.
- **`LayoutResultBuffer.toLayoutResult()` now reports real dimensions**
  (max glyph right edge / lowest bottom) instead of hard-coded zeros.
- **Unknown-font requests resolve instead of hanging.** A queueLayout call whose
  metrics exist nowhere resolves its callback immediately with an error-shaped
  response (`error: 'unknown-font:<id>'`, zero-length buffers) and warns once
  per font id; the worker replies with the same shape rather than returning
  silently, and the main-thread fallback resolves dropped requests the same way.
- **prepare() measures '-' only when a word carries break points**, so text
  without hyphenation opportunities no longer increments the unmeasured-glyph
  tally or consumes the one-time warning.
- **Worker-bundle freshness is enforced**: a new test regenerates the committed
  minified blob in memory and fails when `src/LayoutWorker.ts` changed without a
  rebuild.

Refs #653
