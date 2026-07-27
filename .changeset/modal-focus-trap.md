---
'@vectojs/ui': patch
---

Trap Tab inside an open `Modal`.

`Modal` projected `role="dialog"` with `aria-modal="true"` and moved focus in on
open, but nothing constrained the browser's tab order — `aria-modal` tells
assistive technology that outside content is inert, it does not stop Tab from
leaving. Measured in real Chrome and Firefox: the first Tab after opening landed
on a background control and successive presses walked the whole page behind the
dialog, so a keyboard user was operating things they could not see.

Tab and Shift+Tab now cycle within the dialog's own focusable elements, entering
at the correct edge when focus arrives from outside. Escape-to-close and focus
restoration already worked and are now covered by tests too.

The trap is removed on `close()` and on `destroy()`, so a modal discarded without
closing cannot leave a document listener trapping Tab for the page's lifetime.
