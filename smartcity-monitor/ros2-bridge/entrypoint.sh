#!/bin/bash
# entrypoint.sh — starts the ROS 2 bridge and bag recorder together
# Runs inside the Docker container.

source /opt/ros/humble/setup.bash

# ── Bag directory ─────────────────────────────────────────────────────────────
# Mounted from Windows host via docker-compose volumes: ./bags → /bags
BAG_DIR="/bags"
mkdir -p "$BAG_DIR"

# Each run gets a timestamped folder so flights are never overwritten
BAG_NAME="flight_$(date +%Y%m%d_%H%M%S)"
BAG_PATH="$BAG_DIR/$BAG_NAME"

echo "=================================================="
echo "  Crazyflie ROS 2 Bridge + Bag Recorder"
echo "  Bag will be saved to: $BAG_PATH"
echo "=================================================="

# ── Start the MQTT→ROS2 bridge in the background ─────────────────────────────
python3 /app/crazyflie_ros2_bridge_mqtt.py &
BRIDGE_PID=$!
echo "Bridge started (PID $BRIDGE_PID)"

# ── Wait for bridge to come up and publishers to register ────────────────────
# Give it 3 seconds — the MQTT connection retry loop handles broker delays
sleep 3

# ── Start ros2 bag record ─────────────────────────────────────────────────────
# Records ALL crazyflie topics — covers any number of drones automatically
# /crazyflie/+/pose     → position + orientation (PoseStamped)
# /crazyflie/+/battery  → voltage + percentage (BatteryState)
# /crazyflie/+/status   → full JSON payload (String) — includes halt, controller
#
# --all records every topic that exists, simpler than listing them explicitly
# but produces larger bags. Use topic list below for focused recording:
ros2 bag record \
    --output "$BAG_PATH" \
    --storage mcap \
    --regex "/crazyflie/.*" \
    &
BAG_PID=$!
echo "Bag recorder started (PID $BAG_PID) → $BAG_PATH"

# ── Wait — if either process dies, shut down both cleanly ────────────────────
wait_and_cleanup() {
    echo "Shutting down..."
    kill $BAG_PID  2>/dev/null
    kill $BRIDGE_PID 2>/dev/null
    wait $BAG_PID  2>/dev/null
    wait $BRIDGE_PID 2>/dev/null
    echo "Bag saved to: $BAG_PATH"
    exit 0
}

trap wait_and_cleanup SIGTERM SIGINT

# Keep running until one of the processes exits
while kill -0 $BRIDGE_PID 2>/dev/null && kill -0 $BAG_PID 2>/dev/null; do
    sleep 2
done

wait_and_cleanup
