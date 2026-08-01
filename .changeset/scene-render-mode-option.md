---
"@vectojs/core": minor
---

Accept `renderMode` in `SceneOptions`, and warn in dev mode on unknown option
keys.

`renderMode` was a public field with no matching constructor option, so
`new Scene(canvas, { renderMode: 'onDemand' })` type-checked at the call site,
read correctly, and did nothing — the scene stayed `'always'` and sat on the 2
FPS idle auto-throttle. Four `@vectojs` demos shipped that way. It is now a real
option applied before the first frame, so an `onDemand` scene never pays for the
initial always-on frames. The field stays writable, so existing
`scene.renderMode = …` code is unaffected.

The silent-drop applies to any unrecognized key: `SceneOptions` is structural,
and TypeScript only rejects an extra property when the object literal is inline
at the call site — not when options are built dynamically, and never from plain
JS. In dev mode (`Scene.devMode`, `globalThis.__DEV__`, or
`NODE_ENV=development`) the constructor now warns per unknown key and suggests
the closest real one, or points at the assignment form for a field mistaken as
an option. Production behavior is unchanged. The recognized set is exported as
`SCENE_OPTION_KEYS`.
