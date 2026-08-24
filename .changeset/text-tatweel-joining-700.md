---
'@vectojs/text': patch
---

Arabic shaping now classifies tatweel (U+0640) as dual-joining with an identity glyph mapping, so joining context passes through kashida elongation: adjacent letters keep their initial/medial/final connected forms instead of falling back to isolated ones across the stroke.
