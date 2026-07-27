---
'@vectojs/core': patch
---

Project `required` as the native attribute on form controls.

`A11yAttributes.required` only ever emitted `aria-required`. On an `<input>`,
`<textarea>` or `<select>` the native `required` property is stronger: it
participates in form validation and `:invalid` styling, which the ARIA attribute
merely describes. Native controls now get `required`, and `aria-required` is left
for elements with no native equivalent (e.g. `<div role="textbox">`), rather than
both being set and risking drift.
