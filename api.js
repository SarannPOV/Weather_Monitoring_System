const express = require("express");
const cors = require("cors");
const { Client } = require("pg");

const app = express();

app.use(express.json());
// ===== ENV =====
const PGHOST     = process.env.PGHOST     || "postgres";
const PGUSER     = process.env.PGUSER     || "-------------------------";
const PGPASSWORD = process.env.PGPASSWORD || "-------------------------------";
const PGDATABASE = process.env.PGDATABASE || "iot_db";
const PGPORT     = Number(process.env.PGPORT || 5432);

const PORT       = Number(process.env.PORT || 3000);

// ===== DB =====
const db = new Client({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT
});

app.get("/", (req, res) => res.send("HTTP API is running 🚀"));

// History endpoint (last 24h)
app.get("/api/history", async (req, res) => {
  try {
    const node_id = req.query.node_id || "node_01";
    const limit = Math.min(Number(req.query.limit || 500), 5000);

    const result = await db.query(
      `SELECT node_id,
              temperature, humidity,
              rain_detected, rain_adc, rain_level,
              gas_detected, mq_adc, gas_level,
              created_at
       FROM sensor_data
       WHERE node_id = $1
         AND created_at >= NOW() - INTERVAL '1 day'
       ORDER BY created_at DESC
       LIMIT $2`,
      [node_id, limit]
    );

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

(async () => {
  await db.connect();
  console.log("✅ PostgreSQL connected (HTTP API)");
  app.listen(PORT, () => console.log(`🌐 HTTP API on http://0.0.0.0:${PORT}`));
})();
