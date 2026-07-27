---
'@vectojs/core': patch
---

Avoid the `style.font` shorthand getter in grid calibration.

The calibration scan read `target.style.font` once per grid cell per frame. That
getter re-serializes from every font longhand on each access, making the scan
2.75 ms/frame on Chrome. Cells now mirror their font onto data attributes and
calibration reads those instead: about 1.4x faster, and a streaming code block
absorbs 196-198 of 200 chunks.

Adds `contentProjection`, `a11yNodes`, `gridSync`, `gridCalibrateSchedule`,
`calibScan` and `calibProbeBuild` render phases.
