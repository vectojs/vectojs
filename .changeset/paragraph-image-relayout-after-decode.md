---
'@vectojs/markdown': patch
---

fix(markdown): relayout the blocks below a paragraph image once its bitmap decodes

A standalone Markdown image was laid out against a guessed 16:10 box before its
bitmap decoded. `paragraphImage`'s `onLoad` corrected `Image.width`/`height` from
the real aspect ratio and called `markDirty()`, but nothing re-ran layout — and
`Stack.layout()` positions children from the size each one reported the last time
it ran. So every block after the image kept the position computed from the guess,
and any image taller than the guess (routine: the guess is a flat 0.6 ratio)
rendered underneath the paragraph that followed it.

`markDirty()` alone could never fix this. It schedules a repaint of boxes that are
already wrong.

**A bare `this.content.layout()` does not fix it either, which is the part worth
recording.** `Stack.layout()` is not recursive: it reads each child's current
`width`/`height` and never asks a child to recompute its own box first. Every
image sits behind at least one intermediate container that caches a height — an
image-bearing paragraph is itself a `Stack`, and a list-item or blockquote image
is additionally wrapped in a `MarkdownContainer` — so laying out `content` alone
re-reads the very boxes the decode just invalidated. Measured on `94d6da3`, a
600x900 portrait in `![alt](…)\n\nAfter.`: `Image.height` corrects 480 to 900
while its parent `Stack` stays 480 and the following paragraph stays at `y=496`.

The fix walks bottom-up from the image's own parent to `content`, so each level
sees a freshly-sized child before it positions anything — `Stack`s re-run
`layout()`, `MarkdownContainer` wrappers re-derive their cached box the same way
`reflowToken`'s `blockquote`/`container` arms and every construction site already
do. All five image contexts are covered: standalone, list-item lead, list-item
own-line, blockquote, and an image sharing a paragraph with text.

Two guards, both with tests:

- The walk only runs when the decode actually changed the box, so a correctly
  guessed image and the zero-dimension case (which deliberately keeps its guessed
  box) cost no extra layout pass.
- An image detached before its decode lands — `setContent` or a streamed
  reconcile replacing the subtree mid-flight — is skipped rather than publishing a
  size derived from a tree that is no longer on screen.

Also fixes a second instance of the same root cause: `listItemBlockStack`'s
`leadImages` wrapper (an image leading a list item, `- text ![alt](url)`) was the
one wrapper-image site in the file that never had `width`/`height` assigned at
all, so the outer `Stack` treated it as a zero-height block from construction,
before any decode.
