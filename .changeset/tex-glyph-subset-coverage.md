---
'@vectojs/tex': patch
---

Fixes #666: glyph whitelist holes rendered common symbols as blank ink. The shipped subset was missing Main-Regular U+2248/`≈`, U+210F/`\hbar`, U+2113/`\ell`, U+211C/`\Re`, U+2026/`…`, the whole Script-Regular face (`\mathscr`), all Math-BoldItalic letters (`\boldsymbol`) and Main-Italic digits (`\mathit{123}`/`\textit{123}`) — layout advanced correctly, so these emitted correct-width blank gaps. The subset corpus now exercises every one of those ranges (569 → 662 glyphs, +87), and `glyphCoverage` pins each face so future subsetting cannot silently drop them again.
