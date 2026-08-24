---
'@vectojs/node-editor': patch
---

Fix #627 (follow-up to #624): port activation now requires keyboard provenance.
Core dispatches entity `click` both for Enter/Space synthesis on a focused port
hotspot and for native browser clicks on the projected mirror; only the
keyboard path may arm or commit the connection gesture. A bare pointer click on
a port no longer leaves a phantom pending connection, and releasing a
connect-drag over empty space no longer re-arms through the capture-retargeted
click. Escape cancellation while focus rests on a port hotspot is locked by a
regression test driven at the port entity, exercising the same entity-tree
routing production uses.
