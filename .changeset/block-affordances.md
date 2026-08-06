---
"@vectojs/markdown": minor
---

Add opt-in copy / download controls to code blocks and tables

A reader could see a code block or a table but not take it away. `blockAffordances: true` now draws a copy and a download control in the top-right corner of every fenced code block and every table.

The controls are `@vectojs/ui` `Button`s rather than a bespoke a11y hotspot. `Button` already projects `tag: 'button'` with an accessible name, drives its focus ring from real DOM focus/blur, and handles hover and the disabled state; a hand-rolled hotspot would have had to re-earn all of it. Verified in real Chromium **and** real Firefox: four controls project as real `<button>` elements, a pointer click and a focused `Enter` each deliver the payload, and the accessible name changes to a confirmation and reverts. Firefox's clipboard permission model differs from Chrome's, so both engines were a requirement rather than a nicety.

A wrapper entity owns the corner placement because both candidate parents already own their children's geometry — `Stack` positions each child in flow and `Table` recomputes `x`/`y`/`width`/`height` from its column widths — so a control added directly to either would be moved on the next layout.

Serialization follows `streamdown`, including two details that are commonly omitted and each a real defect when missing: the object URL is revoked after the download click, and CSV carries a UTF-8 BOM so Excel on Windows does not read the file in the system ANSI codepage and corrupt every non-ASCII cell. The BOM is emitted by `tableToCsv` rather than by the file-saving primitive, so it survives a caller supplying its own `saveFile` — a property of the CSV belongs to the CSV.

A table copies as Markdown and downloads as CSV: the reader took it out of a Markdown document, so another Markdown document is the likely destination for a paste, while a spreadsheet is what a file is for. Column alignment is reproduced from the token, so a copied table re-lexes to the alignment it had.

Off by default. It adds two focusable stops per block, which a document with many fences would make tedious to tab past, and a reader who cannot act on a control is better served by not being offered one.
