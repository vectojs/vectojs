---
'@vecto-ui/ui': minor
---

Streaming Markdown plus a wider component suite.

- **`Markdown`**: a canvas Markdown renderer with `setContent()` and `appendMarkdown()` for streaming/LLM output — unchanged prefix paragraphs are reused and a growing paragraph is appended in place, activating the `LayoutEngine` paragraph memo so live output doesn't re-render the whole document. Inline tokens (bold/italic/code/links, with a11y projection) map to `RichText`; a highlighted code block collapses to a single `CodeBlock` leaf entity instead of N×M child entities.
- New components: `Table`, `Dropdown`, `Slider`, `Modal`.
