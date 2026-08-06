---
"@vectojs/markdown": minor
---

Render images in headings and table cells, which previously vanished.

There was no `case 'image'` in the inline switch, so `Tokens.Image` fell to
`default:`, which pushes `.text` — the **alt text rendered as ordinary prose** and
the picture was gone. Nothing threw and nothing was blank, so `# Title ![logo](u)`
simply read as "Title logo". Images in paragraphs, blockquotes and list items were
unaffected; they render through paragraph splitting, so this was 2 of 4 contexts.

An image sharing a line with text now renders as an inline box, reusing the same
mechanism inline math uses, which keeps selection and the accessible name. Its
height is `theme.inlineImageScale` (new, default `1.15`) times the run's font size
and its width follows the natural aspect ratio, so a badge stays wide. A failed
load degrades to the alt text rather than leaving an invisible gap.

Also fixed: `containsImage` walked only `.tokens`, so it returned false for an
image inside a `table` (whose cells live in `header`/`rows`) or a `list` (whose
items live in `items`). A table-cell image therefore never learned its own aspect
ratio and kept the square box it had reserved before decoding.

Two behaviours that were previously undocumented and untested are now both pinned
and described in the README: a definition list renders as its two literal lines,
and a non-SVG raw HTML block renders nothing. Backslash escapes are pinned too —
they worked only because `Tokens.Escape.text` is already unescaped and the
`default:` arm happened to push it.
