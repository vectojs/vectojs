---
"@vectojs/markdown": patch
---

Reuse a streamed image paragraph instead of rebuilding it, and stop dropping an
image that arrives after its text.

A paragraph containing an image renders as a `Stack` of alternating text runs and
`Image`s rather than a single `RichText`, so it had no `setSpans` and fell through
the in-place reuse path to a full rebuild — re-creating the `Image` on every
chunk. The trailing text run is now mutated in place, and a run arriving after the
image is appended. Measured on a growing figure-plus-caption stream, reconcile
time drops 65% in Chrome and 70% in Firefox (total 31% in both).

Also fixes a pre-existing correctness bug found by that work: the in-place branch
dispatched on the _entity_ having `setSpans` without asking whether the new token
still renders as one `RichText`, so a plain paragraph that gained its first image
kept its `RichText` and was handed spans that omit the image entirely — the
picture was silently dropped. Streaming `Figure: ` then `![a](u.png)` produced a
bare text run where a one-shot parse gives a `Stack` with the image.
