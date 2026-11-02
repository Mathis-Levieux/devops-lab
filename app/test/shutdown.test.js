import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createServer, shutdown } from "../src/index.js";

const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      await shutdown(server, { end: async () => {} }, { drainDelay: 0 });
    }
  }
});

function startTestServer() {
  const database = {
    async query() {
      return { rows: [] };
    },
    async end() {},
  };
  const server = createServer({ database, testRoutes: true });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

describe("graceful shutdown", () => {
  it("returns 200 before shutdown and 503 after shutdown starts", async () => {
    const server = await startTestServer();
    const port = server.address().port;

    assert.equal((await fetch(`http://localhost:${port}/healthz`)).status, 200);
    const metrics = await (await fetch(`http://localhost:${port}/metrics`)).text();
    assert.match(metrics, /http_request_duration_seconds/);
    assert.match(metrics, /chaos_events_triggered_total/);
    const stopping = shutdown(server, server.database, { drainDelay: 25 });
    assert.equal((await fetch(`http://localhost:${port}/healthz`)).status, 503);
    await stopping;
  });

  it("waits for an in-flight request before closing", async () => {
    const server = await startTestServer();
    const port = server.address().port;
    const request = fetch(`http://localhost:${port}/__test__/slow`);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = shutdown(server, { end: async () => {} }, { drainDelay: 0 });
    assert.equal((await (await request).json()).status, "completed");
    await stopping;
    assert.equal(server.listening, false);
  });
});
