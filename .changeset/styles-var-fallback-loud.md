---
'@vectojs/styles': patch
---

fix(styles): `var(--token, fallback)` now fails loudly instead of passing through unresolved (#645)

`HAS_VAR_RE` requires `)` immediately after the key characters, so the CSS
fallback form matched no regex: `resolveValue` passed the raw string through to
mapped fields (Canvas2D silently kept the previous paint — the exact GH-608
failure mode) and `trackVarKeys` never registered it, so theme switches never
updated it. A new shared `HAS_VAR_FALLBACK_RE` detects the form anywhere it can
arrive — direct value, embedded in a composite string, inside a padding axis,
or through a token chain — and throws a targeted `TypeError` naming the
offending value. Fallback resolution itself remains unimplemented; silence was
the defect. README rules-of-road updated.
