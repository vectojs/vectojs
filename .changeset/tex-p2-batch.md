---
'@vectojs/tex': patch
---

Fix four emitter gaps where CSS-only information was lost between the span tree and the self-contained SVG:

- Phantom content (`\phantom`, `\vphantom`, `\mathstrut`, …) was drawn as visible ink: the kernel writes `style.color: "transparent"` onto affected nodes, which the emitter never read. It now inherits that state through the tree and skips ink while keeping advances and box metrics.
- TeX colours (`\color`, `\textcolor`) were dropped and unknown commands were indistinguishable from valid content: placements now resolve their colour from the inherited `style.color` chain (which is also how the kernel's `errorColor` reaches the tree) and consecutive same-colour placements are grouped into nested `<g fill="…">` sections, with the root group keeping the caller's default.
- Rules from `\underline`, `\overline`, `\hline`/`\hdashline` and `\sout` were silently dropped: any span carrying `borderBottomWidth` (or the `katex-sout` class) now emits a full-width rect resolved against its vlist extent, the same machinery `frac-line` already used.
- Vlist rows under `op-limits`, `x-arrow`, `mover` and `munder` were flush-left instead of centred, so display-style limits, arrow labels and over/under-braces sat at the operator's left edge rather than under its centre.
