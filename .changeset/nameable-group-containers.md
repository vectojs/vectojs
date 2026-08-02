---
'@vectojs/ui': minor
---

Allow naming the `RadioGroup` and `Tabs` container nodes.

`RadioGroup` projected `role="radiogroup"` with the fixed label `Radio group`,
and `Tabs` projected `role="tablist"` with `Tab switching panel`. Each option
and each tab was already nameable, but the container was not — so a screen
holding several groups announced them identically, and the name that says
*which* choice is being made was unavailable. Both now accept an optional
`label`, defaulting to the previous literals, so existing consumers are
unaffected.
