#!/usr/bin/env node
// Phase 0 spike (#4, DESIGN §2, §9.1): verify the InsightOps webhook contract from Node.
// Not shipped and not imported by src/. Findings go in a comment on #4 and into docs/DESIGN.md;
// the script is kept so they can be re-measured (#28).
//
// Usage:  node --env-file=.env spike/webhook-contract.mjs <probe>
// Probes: lone | newline | stack | stamp | badtoken | size | rate | all   (all runs them in that order)
//
// Env — never pass these on the command line, where they land in shell history:
//   RAPID7_LIVE_TOKEN     ingestion token of a dedicated spike log (a write credential)
//   RAPID7_LIVE_REGION    eu | us | au | ca | jp
//   RAPID7_LIVE_LOG_ID    that log's id, for Query API readback (not the token)
//   RAPID7_QUERY_API_KEY  read-only API key for the Query API
//
// Deliberately global fetch only — no node:* imports and no dependencies — so what it observes is
// what the core's fetch path will see.

const ORDER = ['lone', 'newline', 'stack', 'stamp', 'badtoken', 'size', 'rate'];
const arg = process.argv[2];
const selected = arg === 'all' ? ORDER : ORDER.includes(arg) ? [arg] : null;
if (!selected) {
  console.error(`usage: node --env-file=.env spike/webhook-contract.mjs <${ORDER.join(' | ')} | all>`);
  process.exit(2);
}

const REQUIRED = ['RAPID7_LIVE_TOKEN', 'RAPID7_LIVE_REGION', 'RAPID7_LIVE_LOG_ID', 'RAPID7_QUERY_API_KEY'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`missing env: ${missing.join(', ')}`);
  process.exit(2);
}

const TOKEN = process.env.RAPID7_LIVE_TOKEN;
const REGION = process.env.RAPID7_LIVE_REGION;
const LOG_ID = process.env.RAPID7_LIVE_LOG_ID;
const API_KEY = process.env.RAPID7_QUERY_API_KEY;
const QUERY_BASE =
  REGION === 'us' ? 'https://rest.logs.insight.rapid7.com' : `https://${REGION}.rest.logs.insight.rapid7.com`;

const SIZE_START = 1024;
const SIZE_CEILING = 8 * 1024 * 1024;
const SIZE_PRECISION = 64;
const RATE_STEPS = [1, 8, 16, 32];
const RATE_STEP_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = () => crypto.randomUUID();
const bytes = (s) => new TextEncoder().encode(s).length;
const ok = (status) => status >= 200 && status < 300;
const describe = (err) => ({ name: err.name, message: err.message, code: err.cause?.code });

// Invariant 9: the token travels in the URL path, so every line printed passes through here.
function emit(probe, result) {
  let line = JSON.stringify({ probe, ...result });
  for (const secret of [TOKEN, API_KEY, LOG_ID]) line = line.replaceAll(secret, '<redacted>');
  console.log(line);
}

function pickHeaders(headers, all) {
  const out = {};
  for (const [name, value] of headers) {
    if (all || ['retry-after', 'content-type', 'content-length'].includes(name) || name.startsWith('x-ratelimit')) {
      out[name] = value;
    }
  }
  return out;
}

// The §2.1 request, exactly. Never throws: a failure comes back as { error }.
async function post(body, { token = TOKEN, region = REGION, allHeaders = false } = {}) {
  const url = `https://${region}.webhook.logs.insight.rapid7.com/v1/noformat/${token}`;
  const sentAt = Date.now();
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    return { status: res.status, headers: pickHeaders(res.headers, allHeaders), body: text.slice(0, 300), ms, sentAt };
  } catch (err) {
    return { error: describe(err), ms: Math.round(performance.now() - t0), sentAt };
  }
}

async function queryApi(url, params) {
  const target = params ? `${url}?${new URLSearchParams(params)}` : url;
  for (;;) {
    const res = await fetch(target, { headers: { 'x-api-key': API_KEY }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 2_000);
      continue;
    }
    if (!res.ok) throw new Error(`Query API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

// One LEQL query, followed through its continuation link until it completes.
// `to` runs a minute ahead by default so a server clock slightly ahead of ours cannot hide a
// fresh entry.
async function leql(statement, fromMs, toMs = Date.now() + 60_000) {
  const params = { query: statement, from: fromMs, to: toMs };
  // Measured: the Query API rejects per_page on a calculate() query (errorCode 101009).
  if (!statement.includes('calculate(')) params.per_page = 500;
  let data = await queryApi(`${QUERY_BASE}/query/logs/${LOG_ID}`, params);
  for (let i = 0; i < 60; i++) {
    if (data.events?.length || (i > 0 && data.progress == null)) break;
    const self = data.links?.find((link) => link.rel === 'Self') ?? data.links?.[0];
    if (!self) break;
    await sleep(500);
    data = await queryApi(self.href);
  }
  return data;
}

// Poll until an entry containing `marker` is queryable. foundAfterMs is an upper bound on
// ingestion latency: it includes the Query API's own submit-and-poll round trips.
async function find(marker, sentAt, { timeoutMs = 30_000, settleMs = 0 } = {}) {
  const statement = `where(/${marker}/)`;
  const from = sentAt - 60_000;
  while (Date.now() < sentAt + timeoutMs) {
    let events = (await leql(statement, from)).events ?? [];
    if (events.length) {
      const foundAfterMs = Date.now() - sentAt;
      // A split body may surface its entries a moment apart; look again before concluding.
      if (settleMs) {
        await sleep(settleMs);
        events = (await leql(statement, from)).events ?? events;
      }
      const ingestedAfterMs = Math.min(...events.map((e) => e.timestamp)) - sentAt;
      return {
        foundAfterMs,
        ingestedAfterMs,
        events: events.map((e) => e.message),
        timestamps: events.map((e) => e.timestamp),
      };
    }
    await sleep(250);
  }
  return { foundAfterMs: null, ingestedAfterMs: null, events: [], timestamps: [] };
}

function nestedError() {
  try {
    try {
      JSON.parse('{ not json');
    } catch (inner) {
      throw new Error('spike outer failure', { cause: inner });
    }
  } catch (err) {
    return err;
  }
}

function classifyTwoLine(events, id) {
  const hasA = events.some((m) => m.includes(`A-${id}`));
  const hasB = events.some((m) => m.includes(`B-${id}`));
  if (events.some((m) => m.includes(`A-${id}`) && m.includes(`B-${id}`))) return 'one entry, both lines kept';
  if (hasA && hasB) return 'split into separate entries';
  if (hasA) return 'first line only';
  if (hasB) return 'second line only';
  return 'not stored';
}

// Measured 2026-10-08: past the per-entry cap the endpoint splits a body into consecutive entries
// that share one timestamp, and a piece can be a single byte that no marker search would find.
// So collect every entry at that exact timestamp instead (the log is otherwise quiet during
// this probe), and check whether the pieces reassemble into what was sent.
async function splitPieces(body, timestamp) {
  const { events = [] } = await leql('where(/./)', timestamp, timestamp + 1);
  const pieces = events.map((e) => e.message);
  const reassembles = pieces.join('') === body || [...pieces].reverse().join('') === body;
  return {
    mode: `accepted, split into ${pieces.length} entries`,
    pieceBytes: pieces.map(bytes),
    reassembles,
    replacementChars: pieces.join('').split('�').length - 1,
  };
}

// An ASCII body of exactly `n` bytes (before the trailing \n), bracketed by markers so a body the
// endpoint did not store as one entry shows up as a missing END marker.
async function sizeProbe(n, pad = 'x') {
  const id = uuid();
  const head = `SIZE-${id} n=${n} `;
  const tail = ` END-${id}`;
  const fill = n - bytes(head) - bytes(tail);
  const body = head + pad.repeat(Math.floor(fill / bytes(pad))) + 'x'.repeat(fill % bytes(pad)) + tail;
  const res = await post(`${body}\n`);
  const result = { id, n, chars: body.length, status: res.status, error: res.error };
  if (ok(res.status)) {
    const seen = await find(`SIZE-${id}`, res.sentAt, { timeoutMs: 60_000 });
    const stored = seen.events[0];
    result.storedBytes = stored === undefined ? null : bytes(stored);
    result.mode =
      stored === undefined ? 'accepted, never queryable'
      : stored.includes(`END-${id}`) ? 'ok'
      : 'accepted, not stored as one entry';
    if (result.mode === 'accepted, not stored as one entry') Object.assign(result, await splitPieces(body, seen.timestamps[0]));
  } else {
    result.mode = 'rejected';
  }
  emit('size', result);
  // Spaced out so a rate limit cannot be mistaken for a size limit.
  await sleep(1_000);
  return result;
}

// Double from `start` until `pass` fails or the ceiling is reached, then bisect to SIZE_PRECISION.
async function bisect(start, pass) {
  let lastPass = null;
  let failure = null;
  for (let n = start; n <= SIZE_CEILING; n *= 2) {
    const r = await sizeProbe(n);
    if (!pass(r)) {
      failure = r;
      break;
    }
    lastPass = r;
  }
  while (lastPass && failure && failure.n - lastPass.n > SIZE_PRECISION) {
    const r = await sizeProbe(Math.floor((lastPass.n + failure.n) / 2));
    if (pass(r)) lastPass = r;
    else failure = r;
  }
  return { lastPass, failure };
}

const probes = {
  async lone() {
    console.error('lone: run only after >= 10 minutes with no traffic to this log (DESIGN §1.2). Takes ~9 minutes.');
    const found = [];
    for (let run = 1; run <= 5; run++) {
      if (run > 1) await sleep(120_000);
      const id = uuid();
      const line = `SPIKE-LONE ${id}`;
      const res = await post(`${line}\n`);
      const seen = await find(id, res.sentAt);
      if (seen.foundAfterMs != null) found.push(seen.foundAfterMs);
      emit('lone', {
        run,
        status: res.status,
        error: res.error,
        foundAfterMs: seen.foundAfterMs,
        ingestedAfterMs: seen.ingestedAfterMs,
        intact: seen.events.length === 1 && seen.events[0].trimEnd() === line,
      });
    }
    found.sort((a, b) => a - b);
    emit('lone', {
      summary: true,
      delivered: `${found.length}/5`,
      medianFoundAfterMs: found[Math.floor(found.length / 2)] ?? null,
      maxFoundAfterMs: found.at(-1) ?? null,
    });
  },

  async newline() {
    const variants = {
      lf: (id) => `A-${id} first\nB-${id} second\n`,
      crlf: (id) => `A-${id} first\r\nB-${id} second\r\n`,
      loneCr: (id) => `A-${id} first\rB-${id} second\n`,
      noTrailingNewline: (id) => `A-${id} only line`,
    };
    for (const [variant, make] of Object.entries(variants)) {
      const id = uuid();
      const res = await post(make(id));
      const seen = await find(id, res.sentAt, { settleMs: 5_000 });
      const outcome =
        variant === 'noTrailingNewline' ? (seen.events.length ? 'stored' : 'not stored') : classifyTwoLine(seen.events, id);
      emit('newline', { variant, status: res.status, error: res.error, entries: seen.events.length, outcome, stored: seen.events });
      await sleep(1_000);
    }
  },

  async stack() {
    const id = uuid();
    const err = nestedError();
    // Invariant 2's rule, inlined; the real one belongs to the formatter (#7).
    const line = `STACK-${id} ${err.stack} caused by ${err.cause.stack}`.replace(/\r\n|\n/g, ' ');
    const res = await post(`${line}\n`);
    const seen = await find(id, res.sentAt, { settleMs: 5_000 });
    emit('stack', {
      status: res.status,
      error: res.error,
      entries: seen.events.length,
      identical: seen.events.length === 1 && seen.events[0] === line,
      identicalIgnoringTrailingSpace: seen.events.length === 1 && seen.events[0].trimEnd() === line.trimEnd(),
      sentBytes: bytes(line),
      storedBytes: seen.events.map(bytes),
    });
  },

  async stamp() {
    // §2.5's form: the ID, a colon, then a literal underscore as the pair's value.
    const id = uuid().replaceAll('-', '');
    const line = `[${new Date().toISOString().slice(11, 19)} ERR] ${id}: _ SPIKE-STAMP export failed for run 44`;
    const res = await post(`${line}\n`);
    const seen = await find(id, res.sentAt);
    emit('stamp', {
      status: res.status,
      error: res.error,
      stored: seen.events,
      manualCheck: `In the Rapid7 UI, confirm ${id} renders as a clickable key (DESIGN §2.5)`,
    });
  },

  async badtoken() {
    const variants = {
      randomGuid: { token: uuid() },
      malformed: { token: 'not-a-token' },
      wrongRegion: { region: REGION === 'eu' ? 'us' : 'eu' },
    };
    for (const [variant, options] of Object.entries(variants)) {
      const { sentAt, ...res } = await post(`SPIKE-BADTOKEN ${variant} ${uuid()}\n`, { ...options, allHeaders: true });
      emit('badtoken', { variant, ...res });
      await sleep(1_000);
    }
  },

  async size() {
    // Two limits, measured separately. Measured 2026-10-08: they differ — past the per-entry cap
    // the endpoint still answers 204 and splits the body into several entries (DESIGN §5.4), so
    // the status alone proves nothing.
    const intact = await bisect(SIZE_START, (r) => r.mode === 'ok');
    const accepted = intact.failure ? await bisect(intact.failure.n, (r) => ok(r.status)) : null;
    // Bytes or characters? Over the intact limit in bytes, but far under it in characters.
    const multibyte = intact.failure ? await sizeProbe(intact.failure.n + 1024, '€') : null;
    const pick = (r) => r && { n: r.n, chars: r.chars, mode: r.mode, pieceBytes: r.pieceBytes, reassembles: r.reassembles, replacementChars: r.replacementChars };
    emit('size', {
      summary: true,
      largestIntactBytes: intact.lastPass?.n ?? null,
      smallestSplitBytes: intact.failure?.n ?? null,
      overCap: pick(intact.failure) ?? `none observed up to ${SIZE_CEILING} bytes`,
      largestAcceptedBytes: accepted?.lastPass?.n ?? null,
      smallestRejectedBytes: accepted?.failure?.n ?? null,
      rejectionStatus: accepted?.failure?.status ?? null,
      multibyte: pick(multibyte),
    });
  },

  async rate() {
    const runId = uuid();
    const startedAt = Date.now();
    let firstFailure = null;
    let accepted = 0;
    for (const concurrency of RATE_STEPS) {
      const statuses = {};
      let sent = 0;
      const until = Date.now() + RATE_STEP_MS;
      const worker = async () => {
        while (!firstFailure && Date.now() < until) {
          const { sentAt, ...res } = await post(`RATE-${runId} c=${concurrency} i=${sent++}\n`, { allHeaders: true });
          const key = res.status ?? res.error.name;
          statuses[key] = (statuses[key] ?? 0) + 1;
          if (ok(res.status)) accepted++;
          if (!firstFailure && (res.status === 429 || res.status >= 500)) firstFailure = { concurrency, ...res };
        }
      };
      const t0 = performance.now();
      await Promise.all(Array.from({ length: concurrency }, worker));
      const reqPerSec = Number((sent / ((performance.now() - t0) / 1000)).toFixed(1));
      emit('rate', { concurrency, sent, reqPerSec, statuses });
      if (firstFailure) break;
    }
    emit('rate', firstFailure
      ? { summary: 'stopped at first 429/5xx', firstFailure }
      : { summary: `none observed up to concurrency ${RATE_STEPS.at(-1)}, ${RATE_STEP_MS / 1000}s per step` });

    // Did everything acknowledged with a 2xx actually arrive? Let ingestion catch up first.
    await sleep(15_000);
    const stats = await leql(`where(/RATE-${runId}/) calculate(count)`, startedAt - 60_000);
    emit('rate', { runId, accepted, stored: stats.statistics?.stats?.global_timeseries?.count ?? stats.statistics ?? null });
  },
};

emit('env', { node: process.version, undici: process.versions.undici ?? 'unknown', region: REGION, at: new Date().toISOString() });
for (const name of selected) {
  try {
    await probes[name]();
  } catch (err) {
    emit(name, { aborted: describe(err) });
  }
}
