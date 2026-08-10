---
'@vectojs/markdown': minor
---

Add an optional code-block header band showing the fence language, and stop the
affordance controls overlapping the first line of code

This fixes a real collision, not only a missing feature. Measured on a 900px
default-theme `CodeBlock` with `blockAffordances: true`: the first code line
occupied y 18–42 while both controls sat at y 8–32, so the copy and download
buttons painted over 14px of the first line of every code block that had them.

`new CodeBlock(...)` takes a new trailing `CodeBlockOptions` argument, and
`Markdown` exposes it as `showCodeLanguage`. When enabled, the block reserves a
band above the code and draws the language at its top-left, which is the space
the controls were previously drawing into.

Off by default, for two reasons: the band changes block height, and a document
in a single language would repeat the same word down its whole length. A fence
with no info string reserves nothing even when the option is on, since an empty
band is just wasted space.

The label is normalized through the same rule the highlighter uses for its
lookup key, so the two cannot disagree — a block that renders `ts` is a block
that was highlighted as TypeScript, and ` ```Bash ` or ` ```ts title="a.ts" `
resolve identically in both.

Every row-origin site — the painter baseline, the content projection's `y`, and
the height computation — now reads one `contentTop()` accessor. Applying the
offset to the painter but not the projection is what detaches a selection
carrier from the glyphs it is meant to mirror, and a single accessor makes that
mismatch unrepresentable. Height remains a pure function of line count; the band
only changes the constant term.

Two derived theme keys come with it: `codeLangColor`, which follows
`syntaxCommentColor` when unset because the label has the same "present but
subordinate" role a comment does, and `codeLangFontSize`, which follows
`codeFontSize` so raising the code size scales the label with it.
