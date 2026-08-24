---
'@vectojs/layout': patch
---

Fixed the zero-GC buffer path dropping `baselineShifts` during the BiDi L2 reversal: the RTL swap block now exchanges the shifts array alongside chars/widths/heights/levels, so a shifted glyph in an RTL line keeps its own superscript/subscript offset instead of inheriting another run's. Added an RTL + baselineShift buffer↔allocating parity test.
