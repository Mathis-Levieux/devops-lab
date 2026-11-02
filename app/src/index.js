import express from "express";
import http from "node:http";
import pg from "pg";
import client from "@prometheus-io/client";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://chaos:chaos@localhost:5432/chaos",
});
const register = new client.Registry();
const duration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});
const chaosEvents = new client.Counter({
  name: "chaos_events_triggered_total",
  help: "Number of chaos actions triggered",
  registers: [register],
});
const retainedMemory = [];

export function createApp({ database = pool, testRoutes = false } = {}) {
  const state = { isHealthy: true, isShuttingDown: false };
  const app = express();

  app.use(express.json());
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.socket._isServing = true;
    res.on("finish", () => {
      req.socket._isServing = false;
      duration.observe(
        {
          method: req.method,
          route: req.route?.path || req.path,
          status_code: String(res.statusCode),
        },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      if (state.isShuttingDown) req.socket.destroy();
    });
    next();
  });

  app.get("/healthz", (req, res) => {
    if (state.isShuttingDown) {
      return res.status(503).json({ status: "shutting_down" });
    }
    if (!state.isHealthy) return res.status(500).json({ status: "unhealthy" });
    res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
  });

  app.get("/readyz", async (req, res) => {
    if (state.isShuttingDown || !state.isHealthy) {
      return res.status(503).json({ status: "not_ready" });
    }
    try {
      await database.query("SELECT 1");
      res.json({ status: "ready" });
    } catch (error) {
      console.error("[readyz] PostgreSQL unavailable:", error.message);
      res.status(503).json({ status: "not_ready" });
    }
  });

  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  app.get("/items", async (req, res) => {
    try {
      const result = await database.query(
        "SELECT id, name, created_at FROM items ORDER BY id",
      );
      res.json(result.rows);
    } catch (error) {
      console.error("[items] Could not read items:", error.message);
      res.status(503).json({ error: "database_unavailable" });
    }
  });

  app.post("/items", async (req, res) => {
    const { name } = req.body;
    if (typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    try {
      const result = await database.query(
        "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
        [name.trim()],
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("[items] Could not insert item:", error.message);
      res.status(503).json({ error: "database_unavailable" });
    }
  });

  app.post("/chaos/cpu", (req, res) => {
    const seconds = Number(req.query.seconds || 30);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return res.status(400).json({ error: "seconds must be positive" });
    }
    chaosEvents.inc();
    const end = Date.now() + seconds * 1000;
    let value = 0;
    while (Date.now() < end) value = Math.sqrt(value + Math.random());
    res.json({ chaos: "cpu", seconds, result: value });
  });

  app.post("/chaos/memory", (req, res) => {
    const mb = Number(req.query.mb || 256);
    if (!Number.isInteger(mb) || mb <= 0) {
      return res.status(400).json({ error: "mb must be a positive integer" });
    }
    chaosEvents.inc();
    retainedMemory.push(Buffer.alloc(mb * 1024 * 1024));
    res.json({ chaos: "memory", allocated_mb: mb });
  });

  app.post("/chaos/hang", (req, res) => {
    chaosEvents.inc();
    state.isHealthy = false;
    res.json({ chaos: "hang", health: "unhealthy" });
  });

  if (testRoutes) {
    app.get("/__test__/slow", async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.json({ status: "completed" });
    });
  }

  app.state = state;
  return app;
}

export function createServer({ database = pool, testRoutes = false } = {}) {
  const app = createApp({ database, testRoutes });
  const server = http.createServer(app);
  server.connections = new Set();
  server.on("connection", (socket) => {
    server.connections.add(socket);
    socket._isServing = false;
    socket.once("close", () => server.connections.delete(socket));
  });
  server.appState = app.state;
  server.database = database;
  return server;
}

async function initialize(database = pool) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function shutdown(server, database = pool, {
  signal = "SIGTERM",
  timeout = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25_000,
  drainDelay = 5_000,
} = {}) {
  if (server.isShuttingDown) return server.shutdownPromise;
  server.isShuttingDown = true;
  server.appState.isShuttingDown = true;
  server.shutdownPromise = (async () => {
    console.log(`[shutdown] ${signal} received. Starting graceful shutdown.`);
    await new Promise((resolve) => setTimeout(resolve, drainDelay));
    for (const socket of server.connections) {
      if (!socket._isServing) socket.destroy();
    }
    await Promise.race([
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Shutdown timeout after ${timeout}ms`)),
        timeout,
      )),
    ]);
    await database.end();
    console.log("[shutdown] Cleanup complete.");
  })();
  return server.shutdownPromise;
}

export async function start({ port = Number(process.env.PORT) || 3000 } = {}) {
  client.collectDefaultMetrics({ register });
  await initialize();
  const server = createServer();
  server.listen(port, () => console.log(`[startup] Listening on port ${port}`));
  const stop = (signal) => shutdown(server, pool, { signal }).catch((error) => {
    console.error("[shutdown] Cleanup error:", error);
    process.exitCode = 1;
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("uncaughtException", (error) => {
    console.error("[error] Uncaught exception:", error);
    stop("uncaughtException");
  });
  process.once("unhandledRejection", (reason) => {
    console.error("[error] Unhandled rejection:", reason);
    stop("unhandledRejection");
  });
  return server;
}
