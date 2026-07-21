# @vectojs/markdown

## 0.1.0

### Minor Changes

- e2cad3e: Introduce `@vectojs/markdown` as a standalone package: the `Markdown` entity and
  `CodeBlock`, which parse Markdown with `marked` and render TeX math to SVG with
  MathJax, laid out using `@vectojs/ui` components. Extracted from `@vectojs/ui`
  so the heavy `marked` + `mathjax-full` dependencies are only pulled in by apps
  that actually render Markdown. Depends on `@vectojs/ui` and `@vectojs/core`.
