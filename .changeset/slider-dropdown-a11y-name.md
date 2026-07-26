---
'@vectojs/ui': minor
---

Add `label` to `Slider` and `Dropdown` so they can carry an accessible name.

Both projected their ARIA role but had no way to supply a name, and neither set
one. A screen reader announced them as bare "slider" and "combobox" with no
indication of what they control — a WCAG 4.1.2 failure. Their visual labels are
drawn on canvas, so nothing reached the semantic layer.

```ts
new Slider({ min: 0, max: 100, value: 40, label: 'Volume' });
new Dropdown(['Small', 'Large'], { label: 'Size' });
```

Omitting `label` leaves `aria-label` unset rather than fabricating a name from the
value, since a wrong name is worse than a missing one.

Found by driving the new a11y conformance fixture in real Chrome and Firefox and
reading the browser's accessibility tree. Every unit test had passed over it,
because jsdom has no accessibility tree to inspect.
