# Smart City RF Monitor

Real-time IoT monitoring dashboard for the OCII Smart City RF testbed. Supports live sensor data across four RF bands, RF disruption analysis, drone telemetry, and automated jamming session logging for J/S model calibration.

## Architecture

```text
ESP32 sensors (WiFi 2.4GHz)  ──MQTT──►
433MHz PIR/door sensor        ──MQTT──►  Mosquitto Broker (port 1883)
GPS NEO-F10N (L1/L5)          ──MQTT──►        │
Crazyflie drones (via cflib)  ──MQTT──►        │
LoRaWAN sensors (via gateway)──MQTT──►        │
                                               │
                                      Node.js Backend
                                (Express + Socket.io + better-sqlite3)
                                               │
                                      React Frontend (Vite + Recharts)
                                               │
                                      ROS 2 Bridge (Docker)
                                  (MQTT → ROS 2 topics + MCAP bag recording)
```

## Quick Start

### 1. Backend

```bash
cd backend
npm install
node server.js
```

Runs on **http://localhost:3001**

Demo mode is ON by default — simulates sensor data including jamming events.

To connect real sensors:

```powershell
$env:DEMO_MODE="false"
$env:MQTT_BROKER="mqtt://192.168.1.84:1883"
node server.js
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on **http://localhost:3000**

### 3. Replay Tool (jamming demo without live sensors)

```powershell
cd backend
node replay-jamming.js
node replay-jamming.js --speed 5
node replay-jamming.js --loop --speed 3
node replay-jamming.js --node building-a --file jamming_xiao.json
```

---

## MQTT Payload Format

All sensors publish JSON with `collected_ms` for accurate gap detection during jamming:

```json
{
  "value": 23.4,
  "unit": "°C",
  "collected_ms": 847293
}
```

`collected_ms` is `millis()` from the ESP32. The backend uses consecutive delta values to detect buffering and gaps during RF disruption — critical for J/S model calibration.

GPS node uses `collected_at` (ISO 8601 UTC) when lock is valid, falls back to `collected_ms` with `timestamp_source: "millis_fallback"`.

---

## MQTT Topic Structure

```text
smartcity/<node_id>/<metric>
```

| Node ID | Type | RF Band | Metrics |
|---|---|---|---|
| building-a | hub | 2.4 GHz | video_fps, audio_db, wifi_rssi |
| building-b | environmental | 2.4 GHz | temperature, humidity, wifi_rssi |
| building-c | medical | 2.4 GHz | heart_rate, spo2, wifi_rssi |
| building-d | automation | 2.4 GHz | plug_state, wifi_rssi |
| intersection | traffic | 2.4 GHz | light_state, wifi_rssi |
| perimeter | security | 433 MHz | motion_detected, door_open, signal_433 |
| gps-node | gps | GPS L1/L5 | satellites, snr_l1, snr_l5, lock_status, lat, lng |
| cf-e9 | drone | 2.4 GHz | telemetry (full JSON on smartcity/cf-e9/telemetry) |
| cf-e8 | drone | 2.4 GHz | telemetry (full JSON on smartcity/cf-e8/telemetry) |

### Drone Telemetry Payload Published by `landing_swarm_victim.py` via paho-mqtt

```json
{
  "type": "drone:telemetry",
  "id": "cf-e9",
  "uri": "radio://0/80/2M/E7E7E7E7E9",
  "timestamp": "2026-09-01T18:31:14.000Z",
  "x": 0.23,
  "y": 1.45,
  "z": 0.80,
  "yaw": 45.2,
  "battery": 3.95,
  "controller": "victim",
  "halt": false
}
```

---

## Database

Persistent SQLite at `backend/data/smartcity.db` (better-sqlite3).

- **sensor_readings** — all sensor readings, indexed by node/metric/timestamp, auto-cleaned after 7 days
- **events** — system events (jamming, anomaly, watchdog, drone alerts)
- **jamming_sessions** — one row per controlled RF trial, feeds the J/S sigmoid model
- **rf_events** — RF disruption events

WAL mode enabled for concurrent read/write performance during active sensor streaming.

---

## REST API

### Node Data

| Endpoint | Description |
|---|---|
| GET /api/nodes | All node definitions and live state |
| GET /api/state | Full system state snapshot |
| GET /api/layout | Current sensor layout definition |
| POST /api/layout | Push new layout from Tactical RF Mapper |
| GET /api/drones | Live drone telemetry state |

### Sensor History

| Endpoint | Description |
|---|---|
| GET /api/nodes/:id/history?metric=wifi_rssi&limit=200 | Sensor reading history |
| GET /api/history?node=building-a&metric=wifi_rssi&from=ISO&to=ISO | Time window query |

### Events

| Endpoint | Description |
|---|---|
| GET /api/events | Recent events (all types) |
| GET /api/events?severity=critical | Filtered by severity |

### Jamming Sessions (J/S Model Calibration)

| Endpoint | Description |
|---|---|
| POST /api/jamming-sessions | Log a new jamming trial |
| GET /api/jamming-sessions | List all sessions |
| GET /api/jamming-sessions/:id/data | Sensor data for session window + 30s buffer |
| GET /api/jamming-sessions/summary | Computed packet loss per session — sigmoid model input |
| PATCH /api/jamming-sessions/:id | Correct session metadata |
| DELETE /api/jamming-sessions/:id | Remove a bad/failed trial |

#### Log a jamming session (from any machine on the network)

```bash
curl -X POST http://192.168.1.84:3001/api/jamming-sessions \
  -H "Content-Type: application/json" \
  -d '{
    "started_at": "2026-09-02T18:31:14Z",
    "ended_at":   "2026-09-02T18:32:44Z",
    "node_target": "building-a",
    "frequency":   "2.4ghz",
    "distance_m":  1.5,
    "gain_db":     66,
    "notes":       "trial 3, indoor, bladeRF channel 1"
  }'
```

---

## Automated Jamming Sweep

`run_jamming_sweep.sh` automates a full gain sweep at one jammer position, running a 60-second jam at each gain level and logging each trial to the API automatically:

```bash
./run_jamming_sweep.sh 1.0
./run_jamming_sweep.sh 1.5 20 40 60 66
```

Move the jammer to each distance, run the script once per position. Results feed directly into `/api/jamming-sessions/summary` for sigmoid curve fitting.

---

## ROS 2 Bridge (Docker)

Records drone telemetry as standard ROS 2 topics and MCAP bag files for post-flight analysis.

```text
C:\ros2-bridge\
├── crazyflie_ros2_bridge_mqtt.py
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
└── bags/
```

```powershell
cd C:\ros2-bridge
docker compose up --build
docker compose up
```

ROS 2 topics published per drone:

```text
/crazyflie/cf_e9/pose      geometry_msgs/PoseStamped   (x, y, z + yaw quaternion)
/crazyflie/cf_e9/battery   sensor_msgs/BatteryState    (voltage, percentage)
/crazyflie/cf_e9/status    std_msgs/String             (full JSON payload)
```

Each run creates a timestamped MCAP bag in `C:\ros2-bridge\bags\flight_YYYYMMDD_HHMMSS\`. Open in Foxglove Desktop for 3D flight path visualization.

---

## Dashboard Tabs

| Tab | Description |
|---|---|
| Overview | Node grid + live event rail + active alerts strip |
| Sensors | Per-sensor detail with sparklines |
| GPS | GPS L1/L5 SNR, satellite count, lock status |
| Drone | Live flight path canvas (neon overlay on city layout), telemetry cards, drone events |
| RF Analysis | Transmission rhythm, packet loss, RSSI stability per node. Event-driven sensors (perimeter/433MHz) show signal quality at event time rather than rhythm analysis |
| Events | Unified event stream — sensor, drone, GPS, RF — with severity and category filter tabs |
| RF Interference Mapper | Tactical RF Mapper (iframe) — J/S simulation, frequency-aware loss prediction |
| Data Explorer | Clickable API endpoints for all data |
| Settings | Thresholds, watchdog timeout, config |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| PORT | 3001 | Backend HTTP port |
| MQTT_BROKER | mqtt://localhost:1883 | MQTT broker URL |
| DEMO_MODE | true | Simulate sensor data |

---

## File Structure

```text
smartcity-monitor/
├── backend/
│   ├── server.js
│   ├── data/
│   │   └── smartcity.db
│   ├── replay-jamming.js
│   ├── jamming_xiao.json
│   └── layout.json
├── frontend/
│   ├── src/
│   │   └── App.jsx
│   └── public/
│       └── tactical-mapper.html
└── ros2-bridge/
    ├── crazyflie_ros2_bridge_mqtt.py
    ├── Dockerfile
    ├── docker-compose.yml
    ├── entrypoint.sh
    └── bags/
```

---

## Drone Mission Script

`landing_swarm_victim.py` — runs in VM on same machine as MQTT broker.

- Uses cflib + Lighthouse deck (no Flow deck)
- Three LogConfigs to stay within firmware slot limit (BatteryMonitor uses 7 slots):
  - `Pos` (3 vars, 600ms): stateEstimate.x/y/z
  - `Att` (1 var, 600ms): stateEstimate.yaw
  - `Bat` (1 var, 1000ms): pm.vbat (read from BatteryMonitor)
- Publishes to `smartcity/{drone_id}/telemetry` via persistent paho-mqtt connection
- All battery monitoring decisions, emergency stop checks, and delivery waypoint logic preserved
