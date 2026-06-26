---
'@vecto-ui/core': patch
'@vecto-ui/ui': patch
---

Docs: rewrite READMEs for accurate positioning and honest, reproducible numbers.

Removes the fabricated "React vs core" comparison table (1k/10k/100k → React
"Crash" vs "60 FPS") and the misleading "60 FPS with 100,000+ entities" tagline.
READMEs now describe VectoUI as a Zero-DOM canvas UI runtime with the a11y/agent
moat, cite measured benchmark numbers, list the full component set, document the
IME-capable `Input`, and state where the framework does and doesn't fit.
