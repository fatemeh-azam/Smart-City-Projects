const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const dgram = require('dgram');
const initSqlJs = require('sql.js');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── Database Setup (sql.js — pure JS, no native build needed) ────────────────
let db;
initSqlJs().then(SQL => {
  db = new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      unit TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      node_id TEXT,
      message TEXT,
      severity TEXT DEFAULT 'info',
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS node_status (
      node_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'offline',
      last_seen TEXT,
      ip_address TEXT
    );
  `);

  Object.keys(NODES).forEach(id => {
    db.run(`INSERT OR IGNORE INTO node_status (node_id, status) VALUES (?, ?)`, [id, 'offline']);
  });

  console.log('✅ Database ready (sql.js)');
}).catch(err => {
  console.error('❌ Database init failed:', err.message);
});

function dbRun(sql, params = []) {
  try { if (db) db.run(sql, params); } catch (e) { console.warn('DB run error:', e.message); }
}

function dbAll(sql, params = []) {
  try {
    if (!db) return [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) { console.warn('DB query error:', e.message); return []; }
}

// ─── Node Definitions ─────────────────────────────────────────────────────────
const NODES = {
  'building-a':  { label: 'Building A',   type: 'hub',          icon: 'camera',    metrics: ['video_fps', 'audio_db', 'wifi_rssi'] },
  'building-b':  { label: 'Building B',   type: 'environmental', icon: 'cloud',    metrics: ['temperature', 'humidity', 'wifi_rssi', 'alerts_433'] },
  'building-c':  { label: 'Building C',   type: 'medical',       icon: 'heart',    metrics: ['heart_rate', 'spo2', 'wifi_rssi'] },
  'building-d':  { label: 'Building D',   type: 'automation',    icon: 'plug',     metrics: ['plug_state', 'wifi_rssi'] },
  'intersection':{ label: 'Intersection', type: 'traffic',       icon: 'traffic',  metrics: ['light_state', 'wifi_rssi'] },
  'perimeter':   { label: 'Perimeter',    type: 'security',      icon: 'shield',   metrics: ['motion_detected', 'door_open', 'signal_433'] },
  'gps-node':    { label: 'GPS Node',     type: 'gps',           icon: 'satellite',metrics: ['satellites', 'snr_l1', 'snr_l5', 'lock_status', 'lat', 'lng'] },
};

// ─── In-Memory State ──────────────────────────────────────────────────────────
const nodeState = {};
Object.keys(NODES).forEach(id => {
  nodeState[id] = { status: 'offline', metrics: {}, lastSeen: null };
});

function getUnit(metric) {
  const units = {
    temperature: '°C', humidity: '%', heart_rate: 'bpm', spo2: '%',
    wifi_rssi: 'dBm', video_fps: 'fps', audio_db: 'dB',
    snr_l1: 'dB-Hz', snr_l5: 'dB-Hz', satellites: 'count',
    lat: 'deg', lng: 'deg'
  };
  return units[metric] || '';
}

function updateNodeState(nodeId, metrics) {
  if (!nodeState[nodeId]) return;
  nodeState[nodeId].status = 'online';
  nodeState[nodeId].lastSeen = new Date().toISOString();
  nodeState[nodeId].metrics = { ...nodeState[nodeId].metrics, ...metrics };

  dbRun(`INSERT OR REPLACE INTO node_status (node_id, status, last_seen) VALUES (?, ?, datetime('now'))`, [nodeId, 'online']);

  Object.entries(metrics).forEach(([metric, value]) => {
    if (typeof value === 'number') {
      dbRun(`INSERT INTO sensor_readings (node_id, metric, value, unit) VALUES (?, ?, ?, ?)`,
        [nodeId, metric, value, getUnit(metric)]);
    }
  });

  io.emit('node:update', {
    nodeId,
    metrics,
    status: 'online',
    lastSeen: nodeState[nodeId].lastSeen
  });

  // Jamming detection: sudden RSSI drop
  if (metrics.wifi_rssi !== undefined && metrics.wifi_rssi < -85) {
    logEvent('jamming', nodeId, `Low RSSI on ${NODES[nodeId].label}: ${metrics.wifi_rssi} dBm`, 'warning');
  }
}

function logEvent(type, nodeId, message, severity = 'info') {
  dbRun(`INSERT INTO events (type, node_id, message, severity) VALUES (?, ?, ?, ?)`,
    [type, nodeId, message, severity]);
  io.emit('event:new', { type, nodeId: nodeId, node_id: nodeId, message, severity, timestamp: new Date().toISOString() });
}

// ─── MQTT Client ──────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';

try {
  const mqttClient = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 5000, connectTimeout: 3000 });

  mqttClient.on('connect', () => {
    console.log('✅ MQTT connected:', MQTT_BROKER);
    mqttClient.subscribe('smartcity/#');
    logEvent('system', null, 'MQTT broker connected', 'info');
  });

  mqttClient.on('error', (err) => {
    console.warn('⚠️  MQTT unavailable (demo mode active):', err.message);
    mqttClient.end();
  });

  mqttClient.on('message', (topic, payload) => {
    const parts = topic.split('/');
    if (parts.length < 3 || parts[0] !== 'smartcity') return;
    const nodeId = parts[1];
    const metric = parts[2];
    if (!NODES[nodeId]) return;

    let value;
    try {
      const parsed = JSON.parse(payload.toString());
      value = typeof parsed === 'object' ? parsed : { [metric]: parsed };
    } catch {
      value = { [metric]: parseFloat(payload.toString()) || payload.toString() };
    }
    updateNodeState(nodeId, value);
  });
} catch (e) {
  console.warn('⚠️  MQTT unavailable, running in demo mode');
}

// ─── UDP Stub — Crazyflie / Unity (reserved) ─────────────────────────────────
const UDP_PORT = process.env.UDP_PORT || 9870;
const udpSocket = dgram.createSocket('udp4');

udpSocket.on('message', (msg) => {
  try {
    const data = JSON.parse(msg.toString());
    // Expected: { drone_id, x, y, z, battery, velocity, anomaly }
    io.emit('drone:telemetry', { ...data, timestamp: new Date().toISOString() });
  } catch (e) {
    console.warn('UDP parse error:', e.message);
  }
});

udpSocket.on('error', (err) => {
  console.warn('UDP socket error:', err.message);
});

udpSocket.bind(UDP_PORT, () => {
  console.log(`📡 UDP stub listening on port ${UDP_PORT} (Crazyflie/Unity ready)`);
});

// ─── Demo Mode ────────────────────────────────────────────────────────────────
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

if (DEMO_MODE) {
  console.log('🎮 Demo mode active — simulating sensor data');

  let tick = 0;
  let jammingActive = false;
  let jammingNode = null;

  setInterval(() => {
    tick++;

    if (tick % 60 === 0 && !jammingActive) {
      const ids = Object.keys(NODES);
      jammingNode = ids[Math.floor(Math.random() * ids.length)];
      jammingActive = true;
      const bands = ['2.4 GHz Wi-Fi', '433 MHz', 'GPS L1', 'GPS L5'];
      const band = bands[Math.floor(Math.random() * bands.length)];
      logEvent('jamming', jammingNode, `Jamming detected — ${band} — ${NODES[jammingNode].label} degraded`, 'critical');
      setTimeout(() => { jammingActive = false; jammingNode = null; }, 15000);
    }

    if (tick % 43 === 0) {
      logEvent('security', 'perimeter', '433 MHz motion sensor triggered at East Gate', 'warning');
    }

    const ij = id => jammingActive && jammingNode === id;

    updateNodeState('building-a', {
      video_fps: ij('building-a') ? 0 : +(Math.random() * 5 + 25).toFixed(1),
      audio_db:  ij('building-a') ? null : +(Math.random() * 10 + 55).toFixed(1),
      wifi_rssi: ij('building-a') ? -95 : +(Math.random() * 10 - 60).toFixed(0),
    });

    updateNodeState('building-b', {
      temperature: +(Math.random() * 3 + 22).toFixed(1),
      humidity:    +(Math.random() * 10 + 45).toFixed(1),
      wifi_rssi:   ij('building-b') ? -92 : +(Math.random() * 10 - 58).toFixed(0),
      alerts_433:  ij('perimeter') ? 0 : (Math.random() > 0.97 ? 1 : 0),
    });

    updateNodeState('building-c', {
      heart_rate: ij('building-c') ? null : Math.floor(Math.random() * 20 + 65),
      spo2:       ij('building-c') ? null : +(Math.random() * 3 + 96).toFixed(1),
      wifi_rssi:  ij('building-c') ? -94 : +(Math.random() * 10 - 62).toFixed(0),
    });

    updateNodeState('building-d', {
      plug_state: ij('building-d') ? 'unknown' : (Math.random() > 0.3 ? 'on' : 'off'),
      wifi_rssi:  ij('building-d') ? -90 : +(Math.random() * 10 - 55).toFixed(0),
    });

    const lightCycle = ['green', 'green', 'green', 'yellow', 'red', 'red', 'red'];
    updateNodeState('intersection', {
      light_state: ij('intersection') ? 'green' : lightCycle[Math.floor(tick / 4) % 7],
      wifi_rssi:   ij('intersection') ? -93 : +(Math.random() * 10 - 57).toFixed(0),
    });

    updateNodeState('perimeter', {
      motion_detected: ij('perimeter') ? 0 : (Math.random() > 0.92 ? 1 : 0),
      door_open:       ij('perimeter') ? 0 : (Math.random() > 0.97 ? 1 : 0),
      signal_433:      ij('perimeter') ? -85 : +(Math.random() * 10 - 55).toFixed(0),
    });

    updateNodeState('gps-node', {
      satellites:  ij('gps-node') ? Math.floor(Math.random() * 3) : Math.floor(Math.random() * 4 + 8),
      snr_l1:      ij('gps-node') ? +(Math.random() * 10 + 10).toFixed(1) : +(Math.random() * 10 + 35).toFixed(1),
      snr_l5:      ij('gps-node') ? +(Math.random() * 8 + 8).toFixed(1)  : +(Math.random() * 8 + 38).toFixed(1),
      lock_status: ij('gps-node') ? 'lost' : 'locked',
      lat:         +(36.1540 + (Math.random() - 0.5) * 0.0001).toFixed(6),
      lng:         +(-95.9928 + (Math.random() - 0.5) * 0.0001).toFixed(6),
    });

  }, 1000);
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/nodes', (req, res) => {
  const nodes = Object.entries(NODES).map(([id, def]) => ({
    id, ...def, ...nodeState[id],
  }));
  res.json(nodes);
});

app.get('/api/nodes/:id/history', (req, res) => {
  const { id } = req.params;
  const { metric, limit = 100 } = req.query;
  let sql = `SELECT metric, value, unit, timestamp FROM sensor_readings WHERE node_id = ?`;
  const params = [id];
  if (metric) { sql += ` AND metric = ?`; params.push(metric); }
  sql += ` ORDER BY rowid DESC LIMIT ?`;
  params.push(parseInt(limit));
  res.json(dbAll(sql, params).reverse());
});

app.get('/api/events', (req, res) => {
  const { limit = 50, severity } = req.query;
  let sql = `SELECT * FROM events`;
  const params = [];
  if (severity) { sql += ` WHERE severity = ?`; params.push(severity); }
  sql += ` ORDER BY rowid DESC LIMIT ?`;
  params.push(parseInt(limit));
  res.json(dbAll(sql, params).reverse());
});

app.get('/api/state', (req, res) => {
  res.json({ nodes: nodeState, nodeDefinitions: NODES });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state:full', { nodes: nodeState, nodeDefinitions: NODES });
  const recentEvents = dbAll(`SELECT * FROM events ORDER BY rowid DESC LIMIT 30`).reverse();
  socket.emit('events:recent', recentEvents);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Smart City Monitor running on http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/nodes`);
  console.log(`📡 UDP: port ${UDP_PORT} (Crazyflie/Unity stub)\n`);
});