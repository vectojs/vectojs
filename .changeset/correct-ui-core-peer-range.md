---
"@vectojs/ui": patch
---

Correct the `@vectojs/core` peer range to the version that actually satisfies
its imports.

`@vectojs/ui` declared `>=1.8.0 <2.0.0`, but `src/measure.ts` imports
`getFontMetrics` and `fontMetricsVersion`. Those live in `@vectojs/text` and
reach `@vectojs/core` only through its `export * from '@vectojs/text'`, so they
appear no earlier than the core release that depends on text `0.3.0` —
`@vectojs/core@1.25.0`. Verified by resolving both versions: on core `1.24.0`
the two symbols are `undefined`, on `1.25.0` every symbol `@vectojs/ui` imports
is present.

Installing `@vectojs/ui@2.7.0` against a core in `1.8.0 … 1.24.0` therefore
satisfied the declared range and then failed at import time with
`SyntaxError: Export named 'getFontMetrics' not found in module @vectojs/core`,
taking down any suite that touched the UI. The range now states the real floor,
so a package manager reports the conflict up front. `@vectojs/markdown` already
declared `>=1.25.0` for the same reason.

No runtime code changed — this is a metadata fix.
