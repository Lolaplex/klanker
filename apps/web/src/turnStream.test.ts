import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Kicker,
  StreamLost,
  TurnError,
  httpStatusOf,
  isTransportError,
  runResumableTurn,
  type TurnEvent,
} from "./turnStream.ts";

async function* gen(events: TurnEvent[], fail?: Error): AsyncGenerator<TurnEvent> {
  for (const ev of events) yield ev;
  if (fail) throw fail;
}

async function* failing(err: Error): AsyncGenerator<TurnEvent> {
  throw err;
}

function harness() {
  const seen: TurnEvent[] = [];
  const statuses: (string | null)[] = [];
  let resets = 0;
  return {
    seen,
    statuses,
    resets: () => resets,
    base: {
      onEvent: (ev: TurnEvent) => seen.push(ev),
      onReset: () => {
        resets += 1;
        seen.length = 0;
      },
      onStatus: (s: string | null) => statuses.push(s),
      idleMs: 1_000,
      maxReattach: 3,
      sleep: async () => {},
    },
  };
}

test("classifies transport vs turn errors", () => {
  assert.equal(isTransportError(new TypeError("Load failed")), true);
  assert.equal(isTransportError(new StreamLost("x")), true);
  assert.equal(isTransportError(new TurnError("boom")), false);
  assert.equal(isTransportError(new Error("409: busy")), false);
  assert.equal(isTransportError(new Error("502: bad gateway")), false);
  assert.equal(isTransportError(new Error("502: bad gateway"), true), true);
  assert.equal(httpStatusOf(new Error("404: no such running turn")), 404);
  assert.equal(httpStatusOf(new Error("Load failed")), null);
});

test("network drop mid-turn re-attaches and replays from the start", async () => {
  const h = harness();
  const res = await runResumableTurn({
    ...h.base,
    open: () => gen([{ type: "start" }, { type: "delta", text: "Hal" }], new TypeError("Load failed")),
    reattach: () =>
      gen([
        { type: "attach", run: "r1" },
        { type: "start" },
        { type: "delta", text: "Hal" },
        { type: "delta", text: "lo" },
        { type: "trailer", session: "s1" },
      ]),
  });
  assert.equal(res, "done");
  assert.equal(h.resets(), 1);
  assert.deepEqual(
    h.seen.map((e) => e.text ?? e.type),
    ["Hal", "lo", "trailer"]
  );
  assert.equal(h.statuses.at(-1), null);
});

test("server error event is a real failure (no reattach)", async () => {
  const h = harness();
  let reattached = false;
  await assert.rejects(
    runResumableTurn({
      ...h.base,
      open: () => gen([{ type: "error", text: "Turn timed out." }]),
      reattach: () => {
        reattached = true;
        return gen([]);
      },
    }),
    (e: unknown) => e instanceof TurnError && e.message === "Turn timed out."
  );
  assert.equal(reattached, false);
});

test("HTTP rejection of the initial POST surfaces as error", async () => {
  const h = harness();
  await assert.rejects(
    runResumableTurn({ ...h.base, open: () => failing(new Error("401: unauthorized")), reattach: () => gen([]) }),
    /401/
  );
});

test("404 on reattach means the run is gone -> detached", async () => {
  const h = harness();
  const res = await runResumableTurn({
    ...h.base,
    open: () => failing(new TypeError("Failed to fetch")),
    reattach: () => failing(new Error("404: no such running turn")),
  });
  assert.equal(res, "detached");
});

test("early EOF without trailer re-attaches", async () => {
  const h = harness();
  let n = 0;
  const res = await runResumableTurn({
    ...h.base,
    open: () => gen([{ type: "delta", text: "a" }]),
    reattach: () => {
      n += 1;
      return gen([{ type: "delta", text: "ab" }, { type: "trailer" }]);
    },
  });
  assert.equal(res, "done");
  assert.equal(n, 1);
});

test("retries are bounded", async () => {
  const h = harness();
  let n = 0;
  const res = await runResumableTurn({
    ...h.base,
    maxReattach: 2,
    open: () => failing(new TypeError("Load failed")),
    reattach: () => {
      n += 1;
      return failing(new TypeError("Load failed"));
    },
  });
  assert.equal(res, "detached");
  assert.equal(n, 2);
});

test("idle watchdog turns a silent suspend into a reattach", async () => {
  const h = harness();
  const res = await runResumableTurn({
    ...h.base,
    idleMs: 20,
    open: () =>
      (async function* () {
        yield { type: "delta", text: "x" } as TurnEvent;
        await new Promise(() => {}); // suspended fetch: never resolves
      })(),
    reattach: () => gen([{ type: "trailer" }]),
  });
  assert.equal(res, "done");
});

test("kicker forces a reattach (visibility regain)", async () => {
  const h = harness();
  const kicker = new Kicker();
  setTimeout(() => kicker.kick(), 10);
  const res = await runResumableTurn({
    ...h.base,
    idleMs: 60_000,
    kicker,
    open: () =>
      (async function* () {
        await new Promise(() => {});
      })() as AsyncIterable<TurnEvent>,
    reattach: () => gen([{ type: "delta", text: "done" }, { type: "trailer" }]),
  });
  assert.equal(res, "done");
  assert.deepEqual(h.seen.map((e) => e.text ?? e.type), ["done", "trailer"]);
});
