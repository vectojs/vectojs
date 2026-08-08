---
"@vectojs/core": patch
---

fix(core): keep an unstroked Circle/Rect bounds origin at +0, not -0

The stroke inflation added in #403 computed the bounds origin as `-inflation`,
and negating a zero yields `-0`. `-0 === 0` holds, so arithmetic consumers were
unaffected, but `Object.is(-0, 0)` is false — an unstroked rect's bounds failed
a `toEqual({ x: 0, … })` assertion and would fail any consumer that
identity-compares origins or uses `-0` as a Map key. `JSON.stringify` also
serialises it as `0`, so the value read back differently than it compared.

Both `Circle.getBounds()` and `Rect.getBounds()` now negate only when the
inflation is actually positive, making the no-stroke result byte-identical to
the pre-inflation behaviour.

`Primitives.test.ts` asserted this exactly before #403; that assertion was
loosened to `toBeCloseTo` to accommodate the `-0` instead of fixing the source,
and is restored to an exact `toEqual` here. `ShapeStrokeBounds.test.ts` had
encoded the defect as expected behaviour (`expect(bounds.x).toBe(-0)` with a
comment describing the negation) — corrected to assert `+0` via `Object.is`.

Unit test: `packages/core/test/ShapeStrokeBounds.test.ts`
