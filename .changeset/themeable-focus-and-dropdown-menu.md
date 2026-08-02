---
"@vectojs/ui": minor
---

Make focus rings and the open `Dropdown` menu themeable.

`Button`, `Slider`, and `Dropdown` hardcoded the default palette's cyan
(`#00f0ff`) and dark slate, so a light or warm theme could style a closed
control but not its focus ring or its open menu — the menu opened as a dark
panel with cyan selection and read as a rendering bug rather than a style.
Sibling components (`ProgressBar.accent`, `Slider.progressColor`,
`Tabs.selectedColor`) already exposed their colors; these were the holdouts.

- `Button`: new `focusColor` option.
- `Dropdown`: new `menuBg`, `menuColor`, `menuSelectedBg`, `menuHighlightBg`,
  and `focusColor` props. `focusColor` is forwarded to the trigger and to every
  option row.
- `Slider`: new `focusColor` prop, plus a focus ring it previously **never
  drew at all** despite being keyboard-operable via arrows/Home/End — a
  WCAG 2.4.7 gap. It now tracks `focus`/`blur` and marks the scene dirty so
  render-on-demand scenes repaint the ring.

Every default is unchanged, so existing themes render identically. Forced-colors
mode continues to override all of them with the system `Highlight` color.
