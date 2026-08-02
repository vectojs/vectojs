---
"@vectojs/ui": minor
---

Let `ScrollView` content be selected, and make its scroll physics configurable.

`ScrollView` never overrode `getA11yAttributes()`, so it inherited `Entity`'s
empty object. Being `interactive` (it needs wheel and pointer events) it still
got a viewport-sized semantic mirror from `Scene`, and with no `pointerEvents`
declared that mirror defaulted to `'auto'` and was ordered by `renderOrder`,
while content projections are pinned to `zIndex: 0`. The transparent div
therefore sat above the very text it wraps: a drag-select inside any
`ScrollView` returned `""`. It now declares `pointerEvents: 'none'`, which is
what the attribute was added for — structural containers whose descendants own
the pointer surface. Wheel scrolling is unaffected, because `Scene` binds its
wheel listener to the _content_ projection and dispatches to the owning node
rather than to this mirror. Pointer-_drag_ scrolling directly over selectable
text is the deliberate trade: a drag over text means "select this" everywhere
else.

Scrolling also always used the default spring (`stiffness: 180`,
`damping: 12`), which is underdamped — ζ ≈ 0.447 against a critical 26.83. One
240px wheel tick was measured overshooting 47.45px (19.8%) with 5 direction
reversals, settling to ±0.5px only at 801ms and reporting pending animations for
every one of 181 sampled frames, so a single tick cost roughly 0.8s of
full-rate rendering plus a long tail. That reads as liveliness on a short list
and as a bounce on a document, and there was no public knob. `ScrollViewOptions`
now takes `scrollPhysics?: MotionConfig`, defaulting to today's `'spring'` so
existing behaviour is unchanged, and the package exports
`DOCUMENT_SCROLL_PHYSICS` (`{ stiffness: 180, damping: 27 }`, ζ ≈ 1.006) as the
critically-damped document preset — measured at 0.00px overshoot and 0
reversals over the same travel.
