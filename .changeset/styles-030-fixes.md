---
'@vectojs/styles': minor
---

Fix theme-switch var() tracking (GH-451): per-entity tracking is now key-level, so multiple var() styles on one entity accumulate and a later literal on the same key stops being replayed on switch.

Fix font token semantics (GH-452): preset themes gain independent `fontFamily`/`fontSize`/`fontWeight` tokens; `fontSize` fed a bare-number token and `fontFamily` fed the `font` shorthand token now throw loudly instead of corrupting the composed font string.

Document the property x component support matrix in the README (GH-453): `textAlign` is `left|justify` only, `borderColor` silently skips components without the field, and container detection is by field presence.
