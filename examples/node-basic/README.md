# node-basic

The smallest useful program: confirm your token and region work before integrating.

## Run it

From the repository root (once, so `dist/` exists):

```sh
npm ci && npm run build
cd examples/node-basic && npm install
```

Then, with your log's ingestion token (the GUID at the end of its webhook URL):

```sh
RAPID7_TOKEN=<your token> RAPID7_REGION=eu node index.mjs
```

`RAPID7_REGION` is one of `eu` (default), `us`, `au`, `ca`, `jp`. The token is a **write
credential** — pass it through the environment, never put it in code.

## What you should see

With a token, the lines go to Rapid7 and the program ends with:

```
stats: {"queued":0,"sent":9,"dropped":0,"failed":0,"retried":0}
9 lines accepted by Rapid7 — search the log for service=node-basic
```

In Rapid7, search `service=node-basic`. The three `request …` lines carry a 32-character trace
id in front of the message; click it to see every line of that request, which is what the
stamp is for. (`sent: 9` means *accepted*: a well-formed token for the wrong log is also
accepted with `204` and silently discarded, so if nothing shows up, check the token and region
first.)

## With no token

Set no `RAPID7_TOKEN` and the same program runs on the console — the logger never throws over
configuration. The output is exactly the lines Rapid7 would have stored:

```
[rapid7-logger] no token configured; logging to the console only
[15:33:49 DBG] starting up service=node-basic env=local pid=23468
[15:33:49 INF] Survey published service=node-basic env=local surveyId=42 runId=44
[15:33:49 WRN] Material sync lock contended service=node-basic env=local holder=pod-7 waitedMs=1200
[15:33:49 ERR] Export failed service=node-basic env=local surveyId=42 SyntaxError: Expected property name or '}' in JSON at position 2     at JSON.parse (<anonymous>)     at file:///…/examples/node-basic/index.mjs:29:8     at ModuleJob.run (node:internal/modules/esm/module_job:325:25)     …
[15:33:49 INF] cache miss service=node-basic env=local userId=u-123 key=survey:42
[15:33:49 INF] 96f95c52f9d18d9ab46d64c6ba34aa33: _ request received service=node-basic env=local path=/surveys/42
[15:33:49 INF] 96f95c52f9d18d9ab46d64c6ba34aa33: _ calling the api service=node-basic env=local outbound=00-96f95c52f9d18d9ab46d64c6ba34aa33-ebc0eb95d56aface-01
[15:33:49 INF] 96f95c52f9d18d9ab46d64c6ba34aa33: _ request done service=node-basic env=local userId=u-123
[15:33:49 FTL] Pretend fatal, to show the level service=node-basic env=local exiting=false

stats: {"queued":0,"sent":9,"dropped":0,"failed":0,"retried":0}
no RAPID7_TOKEN set, so everything above went to the console
```

Things to notice:

- The stack trace is **one line**. The endpoint keeps only the first line of a multi-line body,
  so the logger flattens before posting — on the console too, so what you see is what ships.
- `service` and `env` are on every line; `userId` is on every line from the child logger.
- The `request …` lines are prefixed `<trace id>: _ ` — the exact form Rapid7 renders as a
  clickable key. The `outbound` value is the `traceparent` header the next tier should receive.
- Times are UTC.
