---
'@vectojs/video-exporter': minor
---

Add optional audio muxing: `audioPath` in the API and `-a, --audio <file>` in the CLI attach an audio track to the export, encoded as AAC and trimmed to the video length (`-shortest`). Exports stay silent when the option is absent.
