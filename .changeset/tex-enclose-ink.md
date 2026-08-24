---
'@vectojs/tex': patch
---

Fixes #695: enclose boxes, borders and backgrounds now emit ink. `\boxed`, `\fbox`, `\fcolorbox`, `\angl` and `\colorbox` previously drew only their inner glyphs — the emitter handled `borderBottomWidth`/`katex-sout` rules alone and dropped every other border/background style the kernel writes. Border edges (`borderStyle`/`borderWidth` shorthands, `\angl` overrides, and the class-carried `.angl` 0.049em top/right defaults) are emitted as rects resolved against the enclosing vlist extent, and `\colorbox`/`\fcolorbox` backgrounds paint behind the glyphs in a new background layer.
