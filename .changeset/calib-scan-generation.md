---
'@vectojs/core': patch
---

Skip already-calibrated cells in the grid calibration scan.

The scan re-derived a measurement key for every grid cell on every revision bump —
O(cells) per frame to produce ~20 distinct keys. Since carrier reuse leaves an
untouched line's calibrated transforms in place, cells now carry a generation stamp
and the scan visits only unstamped ones, making it O(new cells). When nothing is
pending the pass skips the probe, the forced layout and the two-frame round trip
entirely.

Calibration scan drops 7.2-9.5x (2.75 -> 0.34-0.38 ms/frame on Chrome), and a
streamed code block at 50 chunk/s absorbs 190-200 of 200 chunks.
