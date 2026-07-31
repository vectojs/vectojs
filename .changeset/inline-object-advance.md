---
"@vectojs/layout": minor
"@vectojs/ui": minor
---

Reserve inline advance for a non-text object in a `StyledSpan`

`RichText` could not hold horizontal space for anything it does not shape, so an
inline formula, icon, or embedded box had no way to sit mid-sentence. The only
workaround was a vertical `Stack` of alternating text runs and entities, which
block-breaks the line.

A span may now carry an `InlineObject`:

```ts
import { OBJECT_REPLACEMENT, type StyledSpan } from "@vectojs/layout";

const spans: StyledSpan[] = [
  { text: "the identity " },
  {
    text: OBJECT_REPLACEMENT,
    object: { width: 42, height: 20, depth: 4, alt: "x+1" },
  },
  { text: " holds." },
];
```

The engine reserves `width` instead of measuring the character, sits the box on
the shared text baseline (`depth` is how far it hangs below, matching MathJax's
`vertical-align` with the sign flipped), and grows the line so a tall object is
not clipped. Read the positioned box back off `LayoutNode.object` and draw your
own content there — the engine never paints it, and `RichText` skips the
sentinel rather than drawing a tofu box.

`alt` supplies the accessible name and copied text in place of the sentinel.

New exports from `@vectojs/layout`: `OBJECT_REPLACEMENT`, `InlineObject`.
`StyledSpan`, `PreparedGlyph`, and `LayoutNode` each gain an optional `object`.
Existing callers are unaffected: a span without `object` takes exactly the paths
it did before.
