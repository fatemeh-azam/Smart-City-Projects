# Smart City RF Monitor

Web-based monitoring dashboard for the smart city RF testbed.

## Architecture

```
ESP32 nodes  ──MQTT──►  Mosquitto Broker
                              │
                         Node.js Backend (Express + Socket.io + SQLite)
                              │         └── UDP stub (port 9870, Crazyflie/Unity ready)
                         React Frontend (Vite + Recharts + Tailwind)
```

## Quick Start

### 1. Backend

```bash
cd backend
npm install
npm start          # production
npm run dev        # with nodemon auto-reload
```

Runs on **http://localhost:3001**
Demo mode is ON by default — simulates all sensor data including random jamming events.

To connect real MQTT:
```bash
MQTT_BROKER=mqtt://192.168.x.x:1883 DEMO_MODE=false node server.js
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on **http://localhost:3000**

---

## MQTT Topic Structure

Each ESP32 should publish to:
```
smartcity/<node_id>/<metric>   → single value
smartcity/<node_id>/data       → JSON object with multiple metrics
```

| Node ID       | Topics                                              |
|---------------|-----------------------------------------------------|
| building-a    | video_fps, audio_db, wifi_rssi                      |
| building-b    | temperature, humidity, wifi_rssi, alerts_433        |
| building-c    | heart_rate, spo2, wifi_rssi                         |
| building-d    | plug_state, wifi_rssi                               |
| intersection  | light_state, wifi_rssi                              |
| perimeter     | motion_detected, door_open, signal_433              |
| gps-node      | satellites, snr_l1, snr_l5, lock_status, lat, lng  |

Example ESP32 publish:
```cpp
client.publish("smartcity/building-b/temperature", "23.4");
client.publish("smartcity/gps-node/data", "{\"satellites\":10,\"snr_l1\":38.5,\"lock_status\":\"locked\"}");
```

---

## Crazyflie / Unity Integration (Future)

The backend already listens on UDP port **9870**.

When ready, send JSON from Unity:
```json
{ "drone_id": "cf1", "x": 1.2, "y": 0.8, "z": 0.5, "battery": 3.7, "velocity": 0.3, "anomaly": false }
```

The frontend has a `DroneStub` component placeholder — replace it with a full drone card when integrating.

---

## REST API

| Endpoint                          | Description                        |
|-----------------------------------|------------------------------------|
| GET /api/nodes                    | All node definitions + live state  |
| GET /api/nodes/:id/history        | Sensor reading history             |
| GET /api/events                   | Event log (jamming, security, etc) |
| GET /api/state                    | Full in-memory state snapshot      |

---

## Environment Variables

| Variable     | Default                  | Description               |
|--------------|--------------------------|---------------------------|
| PORT         | 3001                     | Backend HTTP port         |
| MQTT_BROKER  | mqtt://localhost:1883    | MQTT broker URL           |
| DEMO_MODE    | true                     | Simulate sensor data      |
| UDP_PORT     | 9870                     | UDP port for drone data   |
