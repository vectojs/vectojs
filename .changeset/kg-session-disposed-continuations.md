---
'@vectojs/knowledge-graph': patch
---

KnowledgeGraphSession async continuations stop when the session was disposed while their fetch was in flight. bootstrap/expand re-check disposal after each await and syncFromModel guards at the top, so a teardown race no longer drives the disposed Graph3D/camera (the constructor's fire-and-forget bootstrap made this routine).
