import { describe, expect, it } from "vitest";
import { type CassetteStore, createCassetteFetch, type RecordedExchange } from "./cassette.ts";
import { createJevClient } from "./client.ts";
import { JEV_MODEL } from "./model.ts";
import type { Fetch } from "./questions.ts";
import { noul } from "./questions.ts";

function memoryStore() {
  const exchanges = new Map<string, RecordedExchange>();
  const store: CassetteStore = {
    get: (key) => Promise.resolve(exchanges.get(key)),
    put: (key, exchange) => {
      exchanges.set(key, exchange);
      return Promise.resolve();
    },
  };
  return { store, exchanges };
}

function countingUpstream(status = 200) {
  let calls = 0;
  const fetch: Fetch = () => {
    calls += 1;
    const body = {
      model: JEV_MODEL,
      answers: { urgent: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json",
          "x-typesafe-request-id": "req_1",
          "set-cookie": "session=secret",
        },
      }),
    );
  };
  return { fetch, calls: () => calls };
}

const questions = { urgent: noul("Is `message` urgent?") };
const request = { purpose: "test", state: { message: "Help, it is broken" }, questions };

describe("createCassetteFetch", () => {
  it("records a live exchange once and replays it afterwards", async () => {
    const { store, exchanges } = memoryStore();
    const upstream = countingUpstream();
    const fetch = createCassetteFetch({ mode: "record", store, fetch: upstream.fetch });
    const client = createJevClient({ apiKey: "test-key", fetch, maxRetries: 0 });

    const first = await client.ask(request);
    const second = await client.ask(request);

    expect(upstream.calls()).toBe(1);
    expect(exchanges.size).toBe(1);
    expect(second.answers).toEqual(first.answers);
    expect(second.requestId).toBe("req_1");
  });

  it("never stores credentials or unlisted headers", async () => {
    const { store, exchanges } = memoryStore();
    const fetch = createCassetteFetch({ mode: "record", store, fetch: countingUpstream().fetch });
    await createJevClient({ apiKey: "secret-api-key", fetch, maxRetries: 0 }).ask(request);

    const stored = JSON.stringify([...exchanges.values()]);
    expect(stored).not.toContain("secret-api-key");
    expect(stored.toLowerCase()).not.toContain("authorization");
    expect(stored).not.toContain("session=secret");
  });

  it("fails with CASSETTE_MISS in replay mode instead of calling the API", async () => {
    const upstream = countingUpstream();
    const fetch = createCassetteFetch({
      mode: "replay",
      store: memoryStore().store,
      fetch: upstream.fetch,
    });
    const client = createJevClient({ apiKey: "test-key", fetch });

    await expect(client.ask(request)).rejects.toMatchObject({ code: "CASSETTE_MISS" });
    expect(upstream.calls()).toBe(0);
  });

  it("does not record unsuccessful responses", async () => {
    const { store, exchanges } = memoryStore();
    const fetch = createCassetteFetch({
      mode: "record",
      store,
      fetch: countingUpstream(500).fetch,
    });
    await createJevClient({ apiKey: "test-key", fetch, maxRetries: 0 })
      .ask(request)
      .catch(() => undefined);

    expect(exchanges.size).toBe(0);
  });

  it("keys exchanges by request content, independent of the API host", async () => {
    const { store, exchanges } = memoryStore();
    const fetch = createCassetteFetch({ mode: "record", store, fetch: countingUpstream().fetch });
    await createJevClient({ apiKey: "a", fetch }).ask(request);
    await createJevClient({ apiKey: "b", fetch, baseUrl: "https://example.test" }).ask(request);

    expect(exchanges.size).toBe(1);
  });

  it("passes requests straight through in live mode", async () => {
    const upstream = countingUpstream();
    const fetch = createCassetteFetch({
      mode: "live",
      store: memoryStore().store,
      fetch: upstream.fetch,
    });
    const client = createJevClient({ apiKey: "test-key", fetch });
    await client.ask(request);
    await client.ask(request);

    expect(upstream.calls()).toBe(2);
  });
});
