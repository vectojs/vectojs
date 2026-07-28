# Screen reader verification checklist

Manual verification for the projected accessibility layer. This is **tier 3** of
three; the first two run in CI and this one does not, because the assistive
technology it covers cannot be automated from a Linux runner.

| Tier | What it checks                                           | Where                                                     | Automated |
| ---- | -------------------------------------------------------- | --------------------------------------------------------- | --------- |
| 1    | ARIA rule conformance (roles, attributes, containment)   | `packages/ui/e2e/axe-audit.e2e.ts`, real Chrome + Firefox | yes, CI   |
| 2    | Reading order and announced text, derived from the specs | `packages/core/test/A11yAnnouncement.test.ts`, jsdom      | yes, CI   |
| 3    | What real assistive technology actually says and does    | this document                                             | no        |

Tier 2 uses [`@guidepup/virtual-screen-reader`][vsr], a screen reader
implemented from ACCNAME, CORE-AAM, WAI-ARIA and HTML-AAM rather than a driver
for a real one. It catches spec-level regressions cheaply and its own
documentation is explicit that it augments real-AT testing rather than replacing
it. Passing tiers 1 and 2 means the projection is _specified_ correctly; only
tier 3 tells you a real user can operate it.

## Why this tier is manual

CI runs `ubuntu-latest`. Of the matrix below, NVDA needs Windows, VoiceOver needs
macOS or iOS, and TalkBack needs Android. [`@guidepup/guidepup`][guidepup] can
drive NVDA on Windows and VoiceOver on macOS in a headed session, so those two
rows are automatable in principle on the right runner; Narrator, iOS VoiceOver
and TalkBack are not automatable at all today. Adding Windows and macOS runners
for two of six rows would still leave four manual, so the honest split is: keep
CI at the spec level, and do the real-AT pass by hand at release time.

If a Windows or macOS runner is added later, promote those two rows rather than
this whole document.

## When to run this

- Before a release that changed anything under `packages/core/src/tree/Scene.ts`
  projection code, `packages/ui/src/*` a11y attributes, or focus management.
- After any change to the nesting table (`A11Y_REQUIRED_OWNED`) or to the
  reading-order sort.
- When adding a new composite widget.

Record the result in the PR or release notes, including which rows were skipped.
"Not tested on iOS" is useful; silence is not.

## The matrix

| Screen reader | Browser       | OS      | Priority                                                 |
| ------------- | ------------- | ------- | -------------------------------------------------------- |
| NVDA          | Firefox       | Windows | high — the most common pairing among screen reader users |
| NVDA          | Chrome / Edge | Windows | high                                                     |
| Narrator      | Edge          | Windows | medium — ships with the OS                               |
| VoiceOver     | Safari        | macOS   | high                                                     |
| VoiceOver     | Safari        | iOS     | medium — touch interaction differs substantially         |
| TalkBack      | Chrome        | Android | medium                                                   |

## Checks

Run each against a page containing a `Table` (virtualized and not), `Tabs`,
`TreeView`, `RadioGroup`, `Dropdown`, `ContextMenu` with a submenu, `Modal`, and
a `VirtualList` of buttons.

### Structure and naming

- [ ] Every interactive control is reachable and announces a non-empty name.
- [ ] A table announces as a grid with its row and column counts, and moving
      between cells announces the cell, not the whole row.
- [ ] Tabs announce as tabs with their selected state, and the set position
      ("1 of 3") is correct.
- [ ] Tree items announce their level and expanded state.
- [ ] A radio group announces the group name and each option's checked state.
- [ ] A menu item that opens a submenu announces that it has one.
- [ ] Nothing announces a stale name after the underlying content changes.

### Reading order

- [ ] Reading the page linearly matches the visual order, top to bottom then
      inline. Check a layout with two side-by-side columns specifically.
- [ ] Under `dir="rtl"`, inline order reverses.
- [ ] Scrolling a virtualized list does not repeat or skip items, and the
      announced position matches the visible one.

### Focus and keyboard

- [ ] Tab order matches reading order.
- [ ] A composite widget is one tab stop, with arrow keys moving inside it
      (roving tabindex).
- [ ] Opening a modal moves focus into it; Tab cycles within it; Escape closes
      it and returns focus to the opener.
- [ ] Focus never lands on an element that is scrolled out of view or hidden.
- [ ] When a focused control is removed (a virtualized row scrolling away),
      focus does not jump to the top of the page.

### Live regions and state

- [ ] A status message announces once, not repeatedly.
- [ ] A progress bar announces its value changes without flooding.
- [ ] Disabled controls announce as disabled and are not activatable.

### Known differences to expect

These are not bugs; note them rather than filing them.

- Announcement wording differs between readers ("grid" vs "table", whether the
  row is repeated per cell). Judge whether the information is present, not
  whether the phrasing matches.
- iOS VoiceOver uses a swipe rotor rather than Tab; verify the same information
  is reachable, not that the gestures match desktop.
- Verbosity settings change how much is spoken. Test at the default.

[vsr]: https://github.com/guidepup/virtual-screen-reader
[guidepup]: https://github.com/guidepup/guidepup
