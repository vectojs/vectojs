---
'@vectojs/styles': patch
---

Composite `var()` values, font shorthand prefixes, and loud edge failures (GH-608).

`var()` references embedded inside a larger string — `'rgba(var(--rgb), 0.4)'`
— were neither resolved, tracked, nor rejected: the literal garbage was written
to the entity field while Canvas2D silently kept the old value. Embedded
references now resolve by substitution, chains of token-references-token
resolve transitively with path-based cycle detection, and the key is tracked so
theme switches re-resolve composites. Unknown tokens and cycles throw with the
offending chain.

The font shorthand parser understands the full canvas prefix grammar
`[style || variant || weight]? size[/line-height]? family`. `italic 700 16px
Georgia` and `16px/24px Inter` used to collapse everything around the size into
the family, so a later segment change recomposed an invalid string that
Canvas2D drops; size-like segments that cannot be placed now fail loudly, and
line-height segments survive a size change.

`fontSize` enforces its `${number}px` type at runtime: non-px units arriving
through tokens or JS callers used to compose a silently-dropped shorthand and
now throw.

`css()` copies per-axis `padding` objects into the merged result, so the
documented "fresh plain object / does not mutate inputs" contract holds for
nested values too.
