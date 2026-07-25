---
"@vectojs/core": patch
---

Add ARIA live-region and validation-state support to `A11yAttributes`, projected onto each interactive entity's shadow element by `Scene.syncA11y`. Previously there was no `aria-live` anywhere, so streamed chat messages, toasts, and async validation summaries were silent to screen readers (WCAG 4.1.3). `getA11yAttributes()` can now return `live` (`'off'|'polite'|'assertive'`), `atomic`, and `relevant` for live regions, plus `labelledby`, `describedby`, `required`, `invalid`, and `level` for labelling and field-validation state (WCAG 3.3 / 1.3.1). All are dirty-checked and removed when cleared, matching the existing optional-attribute sync.
