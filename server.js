const mqtt = require("mqtt");
const { Client } = require("pg");
const WebSocket = require("ws");
const express = require("express");
const http = require("http");


const cors = require("cors");

const app = express();

// ✅ CORS must be BEFORE routes
app.use(cors({ origin: "*" }));
app.use(express.json());



// ===== ENV =====
const MQTT_HOST  = process.env.MQTT_HOST  || "mqtt://mqtt-broker:1883";
const MQTT_USER  = process.env.MQTT_USER  || "-------------------";
const MQTT_PASS  = process.env.MQTT_PASS  || "-------------------------";

const MQTT_TOPIC = process.env.MQTT_TOPIC || "iot/+/data";

const PGHOST     = process.env.PGHOST     || "postgres";
const PGUSER     = process.env.PGUSER     || "------------------------";
const PGPASSWORD = process.env.PGPASSWORD || "---------------------------------";
const PGDATABASE = process.env.PGDATABASE || "iot_db";
const PGPORT     = Number(process.env.PGPORT || 5432);

const WS_PORT      = Number(process.env.WS_PORT || 3001);
const PREDICT_PORT = Number(process.env.PREDICT_PORT || 3002);

// ===== Thresholds =====
const RAIN_DRY_MIN   = Number(process.env.RAIN_DRY_MIN || 3000);
const RAIN_LIGHT_MIN = Number(process.env.RAIN_LIGHT_MIN || 2000);

const MQ_WARNING_MIN = Number(process.env.MQ_WARNING_MIN || 2320);
const MQ_DANGER_MIN  = Number(process.env.MQ_DANGER_MIN  || 2650);

// ===== Helpers =====
function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rainLevel(rain_detected, rain_adc) {
  if (rain_adc === null || rain_adc === undefined) return rain_detected ? "Rain" : "Dry";
  if (!rain_detected && rain_adc >= RAIN_DRY_MIN) return "Dry";
  if (rain_adc >= RAIN_LIGHT_MIN) return "Light Rain";
  return "Heavy Rain";
}

function gasLevel(gas_detected, mq_adc) {
  if (!gas_detected) return "Normal";
  const v = Number(mq_adc);
  if (!Number.isFinite(v)) return "Detected";
  if (v >= MQ_DANGER_MIN)  return "Danger";
  if (v >= MQ_WARNING_MIN) return "Warning";
  return "Normal";
}

// ===== POSTGRES =====
const db = new Client({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT
});

async function initDb() {
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id SERIAL PRIMARY KEY,
      node_id TEXT NOT NULL,
      temperature REAL,
      humidity REAL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE sensor_data
      ADD COLUMN IF NOT EXISTS rain_detected BOOLEAN,
      ADD COLUMN IF NOT EXISTS rain_adc INTEGER,
      ADD COLUMN IF NOT EXISTS rain_level TEXT,
      ADD COLUMN IF NOT EXISTS gas_detected BOOLEAN,
      ADD COLUMN IF NOT EXISTS mq_adc INTEGER,
      ADD COLUMN IF NOT EXISTS gas_level TEXT;
  `);

  console.log("✅ PostgreSQL connected + schema ready");
}

// ===== WEBSOCKET =====
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on("connection", (ws, req) => {
  console.log(`✅ Dashboard connected (WebSocket) from ${req.socket.remoteAddress}`);
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

// ===== MQTT =====
function initMqtt() {
  const client = mqtt.connect(MQTT_HOST, {
    username: MQTT_USER,
    password: MQTT_PASS
  });

  client.on("connect", () => {
    console.log("✅ MQTT connected");
    client.subscribe(MQTT_TOPIC);
  });

  client.on("message", async (_, payload) => {
    const data = JSON.parse(payload.toString());

    const record = {
      node_id: data.node_id,
      temperature: safeNumber(data.temperature),
      humidity: safeNumber(data.humidity),
      rain_detected: Boolean(data.rain_detected),
      rain_adc: safeNumber(data.rain_adc),
      gas_detected: Boolean(data.gas_detected),
      mq_adc: safeNumber(data.mq_adc),
      created_at: new Date().toISOString()
    };

    record.rain_level = rainLevel(record.rain_detected, record.rain_adc);
    record.gas_level  = gasLevel(record.gas_detected, record.mq_adc);

    broadcast(record);

    await db.query(
      `INSERT INTO sensor_data
      (node_id, temperature, humidity, rain_detected, rain_adc, rain_level, gas_detected, mq_adc, gas_level)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.node_id,
        record.temperature,
        record.humidity,
        record.rain_detected,
        record.rain_adc,
        record.rain_level,
        record.gas_detected,
        record.mq_adc,
        record.gas_level
      ]
    );
  });
}

// ===== AI PREDICT (SAFE) =====
function initPredictApi() {
  const app = express();

  // ✅ ADD THESE TWO LINES (CORS + JSON) for the 3002 app
  app.use(cors({ origin: "*" }));
  app.use(express.json());

  app.get("/api/predict", async (req, res) => {
    try {
      const nodeId = req.query.node_id;
      const horizons = (req.query.horizons || "")
        .split(",").map(Number).filter(Number.isFinite);

      if (!nodeId || horizons.length === 0) {
        return res.status(400).json({ ok: false });
      }

      const r = await db.query(
        `SELECT temperature FROM sensor_data
         WHERE node_id=$1 AND temperature IS NOT NULL
         ORDER BY created_at DESC LIMIT 30`,
        [nodeId]
      );

      if (r.rows.length < 5) {
        return res.json({ ok: false, reason: "not_enough_data" });
      }

      const temps = r.rows.map(x => x.temperature).reverse();
      const n = temps.length;

      const avg = temps.reduce((a,b)=>a+b,0)/n;
      const slope = (temps[n-1] - temps[0]) / n;

      const predictions = {};
      for (const h of horizons) {
        predictions[h] = +(avg + slope * h).toFixed(2);
      }

      res.json({ ok: true, predictions_c: predictions });
    } catch (e) {
      console.error("❌ Predict error:", e.message);
      res.status(500).json({ ok: false });
    }
  });

  http.createServer(app).listen(PREDICT_PORT, "0.0.0.0", () => {
    console.log(`🤖 Predict API listening on ${PREDICT_PORT}`);
  });
}



// ===== START =====
(async () => {
  console.log("🔧 Starting system...");
  await initDb();
  initMqtt();        // realtime FIRST
  initPredictApi(); // AI is now SAFE
})();
