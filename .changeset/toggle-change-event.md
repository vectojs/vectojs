---
'@vecto-ui/ui': patch
---

`Toggle` now emits a `change` event, unifying the form-control event model.

Previously a `Toggle` only invoked its `onChange` constructor callback, so
external `on('change', …)` listeners never fired (its `role="switch"` shadow node
is a `div`, which the Scene doesn't forward native changes for — unlike `Input`
/`Checkbox`). Toggling now goes through a single `change` handler that drives both
`on('change')` and `onChange`, matching the other form components.
