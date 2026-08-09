---
'@vectojs/core': patch
---

Measure the grid calibration's page scale over 256px instead of 1px.

Selecting a code block whose comments are Chinese drew a thin vertical white line
between every pair of adjacent Han glyphs, so the highlight read as `使|用|sudo`.
ASCII lines in the same block highlighted as one continuous band.

Grid calibration recovers the page's own layout scale by reading the client
distance between two absolutely positioned spans, then writes every carrier a
`scaleX` derived from it. The two spans were 1px apart, and a browser rounds
`getBoundingClientRect().left` to 1/64 of a device pixel — a fixed absolute
quantum, so over a 1px basis the whole rounding error lands in the recovered
scale. Measured in real headed Chrome at `devicePixelRatio` 1.1000000685: the 1px
basis read 0.9921875 (63.5/64) on a page whose scale was 1.0, a 0.78% shortfall.

That shrank every carrier's painted advance below its grid pitch, and the browser
sizes selection rects from the painted advance, so consecutive rects stopped
tiling: 18.0001px of pitch selected as 17.8624px, leaving 0.133px unhighlighted
at every CJK seam and 0.061px at every Latin one. At DPR 1.1 those land on a
device-pixel boundary and paint as a full column.

The basis is now 256px, which divides the same fixed rounding by its own length.
Measured over bases of 1/2/10/256/1000px on the same page, every basis of 10px or
more agreed while the 1px read was the outlier. The grid pitch itself was always
correct and is unchanged; only the recovered page scale moves.
