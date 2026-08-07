import assert from "node:assert/strict";
import test from "node:test";
import {
  createAppRoute,
  createPairRoutes,
  createVoiceRoute,
  type AppRouteConfig,
} from "./app-route.ts";

type StreamEvent = { type: string; data: Record<string, unknown> };

function streamOf(events: readonly StreamEvent[]): ReadableStream<StreamEvent> {
  return new ReadableStream<StreamEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

type Harness = {
  readonly handler: ReturnType<typeof createAppRoute>;
  readonly args: Parameters<ReturnType<typeof createAppRoute>>[1];
  readonly echoed: string[];
  readonly sent: Array<{ text: string; continuationToken: string }>;
  readonly streamStarts: number[];
};

function harness(
  events: readonly StreamEvent[],
  overrides: Partial<AppRouteConfig> = {},
  {
    tailIndex = 6,
    active = true,
  }: { tailIndex?: number; active?: boolean } = {},
): Harness {
  const echoed: string[] = [];
  const sent: Array<{ text: string; continuationToken: string }> = [];
  const streamStarts: number[] = [];
  const handler = createAppRoute({
    bearer: "secret-token",
    chatId: "4242",
    userId: "77",
    echo: (text) => {
      echoed.push(text);
      return Promise.resolve();
    },
    notify: () => Promise.resolve(true),
    isBusy: () => false,
    now: () => 1_000,
    timeoutMs: 120_000,
    ...overrides,
  });
  const args = {
    send: (text: unknown, options: { continuationToken: string }) => {
      sent.push({
        text: String(text),
        continuationToken: options.continuationToken,
      });
      return Promise.resolve({
        getEventStream: ({ startIndex }: { startIndex: number }) => {
          streamStarts.push(startIndex);
          return Promise.resolve(streamOf(events));
        },
      });
    },
    resolveActiveSession: () =>
      Promise.resolve(active ? { sessionId: "session-1" } : undefined),
    getSession: () => ({
      getStreamTailIndex: () => Promise.resolve(tailIndex),
    }),
  } as unknown as Harness["args"];
  return { handler, args, echoed, sent, streamStarts };
}

function request(
  body: unknown,
  bearer: string | null = "secret-token",
): Request {
  return new Request("http://iva.local/eve/v1/app", {
    method: "POST",
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ANSWER: StreamEvent[] = [
  { type: "turn.started", data: { turnId: "t1" } },
  {
    type: "message.completed",
    data: { finishReason: "tool-calls", message: "chiamo un tool" },
  },
  {
    type: "message.completed",
    data: { finishReason: "stop", message: "Ciao" },
  },
  {
    type: "message.completed",
    data: { finishReason: "stop", message: "Fatto." },
  },
  { type: "turn.completed", data: { turnId: "t1" } },
];

void test("a dictated turn answers with the assistant text and echoes once", async () => {
  const h = harness(ANSWER);
  const response = await h.handler(
    request({ text: "  ricordami il latte  " }),
    h.args,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "Ciao\n\nFatto." });
  // The reply is posted to Telegram by the channel itself — echoing it here too
  // would send it twice. Only the dictated text needs mirroring.
  assert.deepEqual(h.echoed, ["ricordami il latte"]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.text, "ricordami il latte");
});

void test("a turn already running when we start is not mistaken for our reply", async () => {
  // The tail of another turn ("other") is in view because we took our stream
  // position mid-flight; only OUR turn (t1) may be read back to the app.
  const raced: StreamEvent[] = [
    {
      type: "message.completed",
      data: {
        finishReason: "stop",
        turnId: "other",
        message: "risposta all'altra domanda",
      },
    },
    { type: "turn.completed", data: { turnId: "other" } },
    { type: "turn.started", data: { turnId: "t1" } },
    {
      type: "message.completed",
      data: { finishReason: "stop", turnId: "t1", message: "la mia risposta" },
    },
    { type: "turn.completed", data: { turnId: "t1" } },
  ];
  const h = harness(raced);
  const response = await h.handler(request({ text: "domanda" }), h.args);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "la mia risposta" });
});

void test("the turn is addressed to the chat's own session", async () => {
  const h = harness(ANSWER);
  await h.handler(request({ text: "ciao" }), h.args);

  // Whatever eve's token format is, it has to carry the chat this app speaks into,
  // or the turn would land in a session of its own and lose the Telegram history.
  assert.match(h.sent[0]?.continuationToken ?? "", /4242/u);
});

void test("reading starts just past the tail so no event of the turn is missed", async () => {
  const h = harness(ANSWER, {}, { tailIndex: 6 });
  await h.handler(request({ text: "ciao" }), h.args);
  assert.deepEqual(h.streamStarts, [7]);
});

void test("a session that does not exist yet is read from the beginning", async () => {
  const h = harness(ANSWER, {}, { active: false });
  await h.handler(request({ text: "ciao" }), h.args);
  assert.deepEqual(h.streamStarts, [0]);
});

void test("a wrong, malformed or missing bearer is rejected without a turn", async () => {
  for (const bearer of ["wrong-token", "", null]) {
    const h = harness(ANSWER);
    const response = await h.handler(request({ text: "ciao" }, bearer), h.args);
    assert.equal(response.status, 401, `bearer: ${String(bearer)}`);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.echoed, []);
  }
});

void test("an unset secret locks everyone out instead of letting everyone in", async () => {
  for (const bearer of [undefined, "", "   "]) {
    const h = harness(ANSWER, { bearer });
    const response = await h.handler(
      request({ text: "ciao" }, "secret-token"),
      h.args,
    );
    assert.equal(response.status, 401, `configured: ${String(bearer)}`);
    assert.deepEqual(h.sent, []);
  }
});

void test("an empty dictation never reaches the model", async () => {
  for (const body of [
    { text: "   " },
    { text: "" },
    { text: 7 },
    {},
    "not json",
    [],
  ]) {
    const h = harness(ANSWER);
    const response = await h.handler(request(body), h.args);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.echoed, []);
  }
});

void test("a chat with a running turn is refused instead of interleaved", async () => {
  const h = harness(ANSWER, { isBusy: () => true });
  const response = await h.handler(request({ text: "ciao" }), h.args);

  assert.equal(response.status, 409);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.echoed, []);
});

void test("a failed turn answers right away instead of waiting for the timeout", async () => {
  const h = harness([
    { type: "turn.started", data: { turnId: "t1" } },
    { type: "turn.failed", data: { turnId: "t1", message: "provider down" } },
  ]);
  const response = await h.handler(request({ text: "ciao" }), h.args);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider down" });
});

void test("a cancelled turn is not reported as an answer", async () => {
  const h = harness([
    { type: "turn.started", data: { turnId: "t1" } },
    { type: "turn.cancelled", data: { turnId: "t1" } },
  ]);
  const response = await h.handler(request({ text: "ciao" }), h.args);
  assert.equal(response.status, 409);
});

void test("a turn that outlives the budget gives up and points at Telegram", async () => {
  const h = harness(ANSWER, { timeoutMs: 0 });
  const response = await h.handler(request({ text: "ciao" }), h.args);

  assert.equal(response.status, 504);
  // The text was already sent, so the answer still arrives in the chat.
  assert.equal(h.sent.length, 1);
});

void test("a stream that ends without a terminal event does not answer empty", async () => {
  const h = harness([{ type: "turn.started", data: { turnId: "t1" } }]);
  const response = await h.handler(request({ text: "ciao" }), h.args);
  assert.equal(response.status, 504);
});

void test("a stolen token cannot burn credits without limit", async () => {
  let clock = 1_000;
  const h = harness(ANSWER, { isBusy: () => true, now: () => clock });

  for (let i = 0; i < 30; i += 1) {
    const response = await h.handler(request({ text: "ciao" }), h.args);
    assert.equal(response.status, 409, `request ${i}`);
  }
  assert.equal(
    (await h.handler(request({ text: "ciao" }), h.args)).status,
    429,
  );

  // The window rolls: a minute later the same token is served again.
  clock += 60_001;
  assert.equal(
    (await h.handler(request({ text: "ciao" }), h.args)).status,
    409,
  );
});

// --- la rotta della voce ---------------------------------------------------

function voiceHarness(upstream: (request: Request) => Promise<Response>) {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(init?.body ?? ""));
    return upstream(new Request(String(input), init));
  }) as typeof fetch;
  const handler = createVoiceRoute({
    bearer: "secret-token",
    chatId: "4242",
    userId: "77",
    echo: () => Promise.resolve(),
    notify: () => Promise.resolve(true),
    isBusy: () => false,
    now: () => 1_000,
    timeoutMs: 120_000,
  });
  return { handler, asked, restore: () => (globalThis.fetch = original) };
}

const WAV = new Response(new Uint8Array([82, 73, 70, 70]), {
  headers: { "content-type": "audio/wav" },
});

void test("the spoken reply comes back as audio", async (t) => {
  const h = voiceHarness(() => Promise.resolve(WAV));
  t.after(h.restore);

  const response = await h.handler(request({ text: "ciao" }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.deepEqual(JSON.parse(h.asked[0] ?? "{}"), { text: "ciao" });
});

void test("speaking needs the same secret as talking", async (t) => {
  const h = voiceHarness(() => Promise.resolve(WAV));
  t.after(h.restore);

  for (const bearer of ["wrong", null]) {
    const response = await h.handler(request({ text: "ciao" }, bearer));
    assert.equal(response.status, 401, `bearer: ${String(bearer)}`);
  }
  // Nothing was ever asked of the synthesiser.
  assert.deepEqual(h.asked, []);
});

void test("nothing to say is not sent to the synthesiser", async (t) => {
  const h = voiceHarness(() => Promise.resolve(WAV));
  t.after(h.restore);

  assert.equal((await h.handler(request({ text: "  " }))).status, 400);
  assert.deepEqual(h.asked, []);
});

void test("a voice that is down says so, so the app can use its own", async (t) => {
  // Both shapes of failure: the synthesiser answering badly, and not answering at all.
  const failing = voiceHarness(() =>
    Promise.resolve(new Response("", { status: 500 })),
  );
  assert.equal((await failing.handler(request({ text: "ciao" }))).status, 503);
  failing.restore();

  const unreachable = voiceHarness(() =>
    Promise.reject(new Error("connection refused")),
  );
  t.after(unreachable.restore);
  assert.equal(
    (await unreachable.handler(request({ text: "ciao" }))).status,
    503,
  );
});

// --- il pairing con codice a 6 cifre ---------------------------------------

function pairHarness(overrides: Partial<AppRouteConfig> = {}) {
  const notified: string[] = [];
  let now = 1_000;
  const routes = createPairRoutes({
    bearer: "secret-token",
    chatId: "4242",
    userId: "77",
    echo: () => Promise.resolve(),
    notify: (text) => {
      notified.push(text);
      return Promise.resolve(true);
    },
    isBusy: () => false,
    now: () => now,
    timeoutMs: 120_000,
    ...overrides,
  });
  return {
    routes,
    notified,
    // The last code that went out to Telegram — what the owner would type in.
    code: () => /\b(\d{6})\b/.exec(notified.at(-1) ?? "")?.[1] ?? "",
    tick: (ms: number) => (now += ms),
  };
}

function claimRequest(code: unknown): Request {
  return new Request("http://iva.local/eve/v1/app/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

void test("a code from Telegram trades for the bearer, exactly once", async () => {
  const h = pairHarness();

  assert.equal((await h.routes.issue()).status, 200);
  assert.equal(h.notified.length, 1);
  assert.match(h.code(), /^\d{6}$/);

  const claimed = await h.routes.claim(claimRequest(h.code()));
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), { token: "secret-token" });

  // The same code must not hand the token to a second device.
  assert.equal((await h.routes.claim(claimRequest(h.code()))).status, 401);
});

void test("wrong guesses burn the code before the space can be searched", async () => {
  const h = pairHarness();
  await h.routes.issue();

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await h.routes.claim(claimRequest("000000"))).status, 401);
  }
  // The guess budget is spent: even the right code is dead now.
  assert.equal((await h.routes.claim(claimRequest(h.code()))).status, 429);
  assert.equal((await h.routes.claim(claimRequest(h.code()))).status, 401);
});

void test("codes expire and issuing is cooled down", async () => {
  const h = pairHarness();

  await h.routes.issue();
  assert.equal((await h.routes.issue()).status, 429);
  h.tick(31_000);
  assert.equal((await h.routes.issue()).status, 200);

  h.tick(5 * 60_000 + 1);
  assert.equal((await h.routes.claim(claimRequest(h.code()))).status, 401);
});

void test("a malformed claim is a client mistake, not a guess", async () => {
  const h = pairHarness();
  await h.routes.issue();

  for (const code of ["12345", "1234567", "abcdef", 123456, null]) {
    assert.equal(
      (await h.routes.claim(claimRequest(code))).status,
      400,
      `code: ${String(code)}`,
    );
  }
  // None of those touched the guess budget: the right code still works.
  assert.equal((await h.routes.claim(claimRequest(h.code()))).status, 200);
});

void test("pairing is locked while the app secret is unset", async () => {
  const h = pairHarness({ bearer: undefined });
  assert.equal((await h.routes.issue()).status, 503);
  assert.equal((await h.routes.claim(claimRequest("123456"))).status, 503);
  assert.deepEqual(h.notified, []);
});

void test("a code Telegram never delivered cannot be claimed", async () => {
  const h = pairHarness({ notify: () => Promise.resolve(false) });
  assert.equal((await h.routes.issue()).status, 502);
  h.tick(31_000);
  // No live code survives a failed delivery — there is nothing to guess against.
  assert.equal((await h.routes.claim(claimRequest("000000"))).status, 401);
});
