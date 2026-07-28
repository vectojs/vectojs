---
'@vectojs/devtools': minor
---

Add a page-backend / frontend bridge protocol.

`createDevtoolsBackend(scene, transport)` serves 21 methods over a transport:
tree, entity inspection and picking, highlight geometry, layout and a11y audits,
snapshot and diff, hit explanation, text, Markdown streaming, GPU counters, plus
plugin inspectors, audits and commands. `createDevtoolsClient(transport)` issues
requests and correlates responses, with a timeout so a dead backend cannot hang a
caller.

Protocol only. The in-page panel is untouched and still calls the headless
functions directly. Defining the protocol first and validating it against one real
consumer is worth more than rebuilding the UI around an unvalidated protocol, and
the same backend then serves an extension, Playwright and an agent without four
implementations of the same queries drifting apart.

**Origin enforcement has no permissive default.** A backend answers questions
about the whole scene — text content, accessible names, geometry — so one that
replies to any sender is an information-disclosure vector reachable by any frame
that can post to the window. Requests carrying an origin are refused unless that
origin is in `allowedOrigins`, and omitting the option refuses all of them.
In-process callers carry no origin and are served, which is the panel and agent
case. `createWindowTransport` forwards the sender's origin specifically so the
check is possible.

Results are round-tripped through JSON in the backend, so a handler that leaked a
live entity reference fails in the backend's own tests rather than as a
structured-clone error inside somebody's extension. `tree.get` is capped and
reports `truncated` rather than silently returning part of a tree.
