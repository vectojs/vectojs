---
'@vectojs/devtools': minor
---

Add a plugin protocol so other packages can contribute DevTools panels.

`registerDevtoolsPlugin({ inspectors, audits, commands })` returns a deregister
function. Each inspector becomes a tab, filled from the current selection on
refresh; audits merge into the existing audit list with their kind namespaced by
plugin id; commands are addressable as `<pluginId>/<commandId>` and runnable via
`panel.runCommand()`.

The point is dependency direction: `markdown`, `text`, `graph3d` and `three` can
contribute panels without `@vectojs/devtools` importing any of them, where a
hardcoded tab per package would invert the graph and put a debug tool in the way
of every new component.

Also fixes the tab bar, which divided its width by the tab count — six built-in
tabs at a 320px dock already sat near 51px each, and plugins pushed that to 27px.
Tabs now keep a preferred width and the bar scrolls horizontally once they
overflow: measured with 8 plugins, 13 tabs hold at 48px across a 624px bar that
scrolls 320px, and selecting the last tab scrolls it into view.

Every call into plugin code is wrapped. A throwing `appliesTo` excludes just that
inspector, a throwing `rows` renders the error in its own tab, and a throwing
audit becomes an `audit-failed` finding, so one broken plugin cannot take the
panel down with it.
