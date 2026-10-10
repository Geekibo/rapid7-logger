---
"@geekibo/rapid7-logger": minor
---

`captureConsole(logger, options?)`, exported from `/`, `/next` and `/edge`: opt-in forwarding of `console.warn` and `console.error` (by default; any method via `levels`) into a logger, with `%s`-style interpolation, `Error` arguments as the event error and objects as redacted context. The original methods still run unless `passthrough: false`; `restore()` undoes it. The console fallback and the logger's own warnings always write through the original methods, so capturing without a token configured cannot loop.
