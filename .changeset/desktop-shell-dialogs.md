---
'@vectojs/desktop': minor
---

Shell-level dialog API: `WindowManager.openDialog(opts)` (and `DesktopShell.openDialog`) opens floating, optionally-modal windows with no AppRegistry entry — built for shell-modal confirm prompts where `open()` previously forced apps into in-window overlay workarounds. `OpenDialogOptions` takes `title`, optional `width`/`height`/`x`/`y` (default: centered and clamped on the work area), a `content` entity or `(ctx) => Entity` builder whose `AppContext.close()` dismisses the dialog, plus `modal` (default `true`) and `dismissible` (default `true`, Escape closes). Modal dialogs hold focus — programmatic, click-driven, and Alt+Tab refocus of other windows is blocked until close, which restores focus to the opener. Dialogs project `role="dialog"` named by title (`ariaModal` when modal), carry close-only chrome (no resize/maximize/minimize), and are excluded from taskbar entries. Existing `open()`/focus/cycle paths are unchanged when the API is unused.
