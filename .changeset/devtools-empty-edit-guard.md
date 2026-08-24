---
'@vectojs/devtools': patch
---

fix(devtools): clearing an inspector editor field no longer snaps x/y/opacity to 0 (#704)

The numeric property editors parsed input with `Number(raw)`, but `Number('')`
and `Number('   ')` are `0`, not NaN. The editors fire on every native `input`
event, so select-all + delete — or backspacing past the first digit — applied
`x = 0` / `y = 0` / `opacity = 0` mid-edit; opacity 0 additionally made the
entity invisible and unhittable. Empty/whitespace input is now ignored before
the parse; a subsequent numeric value applies as before.
