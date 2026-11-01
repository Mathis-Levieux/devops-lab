import express from "express";
import pg from "pg";
import client from "@prometheus-io/client";

const { Pool } = pg;
const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgres://chaos:chaos@localhost:5432/chaos",
});
const collectDefaultMetrics = client.collectDefaultMetrics;
const Registry = client.Registry;
const register = new Registry();
collectDefaultMetrics({ register });

const duration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
});
const chaosEvents = new client.Counter({
  name: "chaos_events_triggered_total",
  help: "Number of chaos actions triggered",
});
const retainedMemory = [];
let isHealthy = true;

app.use(express.json());
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path || req.path;
    duration.observe(
      { method: req.method, route, status_code: String(res.statusCode) },
      Number(process.hrtime.bigint() - started) / 1e9,
    );
  });
  next();
});

app.get("/healthz", (req, res) => {
  if (!isHealthy) return res.status(500).json({ status: "unhealthy" });
  res.json({ status: "ok" });
});

app.get("/readyz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
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
    const result = await pool.query(
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
    const result = await pool.query(
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
  isHealthy = false;
  res.json({ chaos: "hang", health: "unhealthy" });
});

async function initialize() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (error) {
    console.error("[startup] Could not initialize PostgreSQL:", error.message);
  }
}

export async function start() {
  client.collectDefaultMetrics();
  await initialize();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`[startup] Listening on port ${port}`));
}
