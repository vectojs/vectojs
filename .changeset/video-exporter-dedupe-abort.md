---
'@vectojs/video-exporter': patch
---

chore(video-exporter): deduplicate the abortError helper (#661)

The `abortError` helper was maintained byte-identical in both
`export-session.ts` and `ffmpeg-supervisor.ts`; hoisted to
`src/abort-error.ts` and imported by both. No behavior change — identical
messages, `AbortError` name and `cause` wiring on every cancellation path.
