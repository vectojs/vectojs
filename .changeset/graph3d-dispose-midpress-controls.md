---
'@vectojs/graph3d': patch
---

GraphInteraction.dispose() during a press below the drag threshold now re-enables the host's controls. onPointerDown disables them eagerly, and with the pointer listeners removed no later pointerup or pointercancel could — the host's camera/pan controls stayed disabled until a full reload.
