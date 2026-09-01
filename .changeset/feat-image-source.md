---
"@vectojs/ui": minor
---

feat(ui): ImageSource abstraction with string|url|blob|bitmap and DecodedImage

Unify url/blob/ImageBitmap behind ImageSource, string shorthand for url, DecodedImage decouples decode from renderBitmap, keeps backward compat for new Image(string, opts).
