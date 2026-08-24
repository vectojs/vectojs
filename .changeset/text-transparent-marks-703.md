---
'@vectojs/text': patch
---

`ArabicShaper.isHarakat` now covers the full set of joining-type-transparent combining marks: beyond the core harakat ranges it recognizes the honorific signs U+0610–U+061A and Quranic annotation signs U+06D6–U+06ED, so shaping skips across them (ligatures form, contextual connections hold) instead of treating them as opaque bases that disconnect adjacent letters.
