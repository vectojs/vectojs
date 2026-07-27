---
'@vectojs/ui': minor
---

Add `Button.disabled` and `Input`/`TextArea` `required` + `invalid`.

`A11yAttributes` has supported all three since the projection layer was written,
but no component wired them, so an app could not express "this control is
unavailable" or "this field failed validation" **at all** — visually or
semantically. Found while building the a11y conformance fixture, which had to
stand these in with local entities.

```ts
new Button('Save', { disabled: true });
new Input({ width: 220, placeholder: 'Email', required: true, invalid: true });
```

All three are also accessors, so state can change after construction and the drawn
appearance and projected semantics move together. That coupling is the point: a
control drawn as unavailable whose shadow node still reports enabled tells sighted
and screen-reader users opposite things.

`Button.disabled` gates activation on **both** input paths. The browser suppresses
a DOM click on a disabled `<button>`, but the canvas hit-test dispatches
independently, so without an explicit gate a disabled button still fired when
clicked on the canvas. Hover and focus states are also suppressed.

Under forced-colors mode the disabled and invalid states defer to system colours
(`GrayText`, `LinkText`) rather than themed ones, since that mode exists so the OS
picks contrast.
