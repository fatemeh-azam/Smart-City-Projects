#!/usr/bin/env python3
"""
crazyflie_ros2_bridge_mqtt.py

Runs INSIDE Docker. Subscribes to the smart city MQTT stream produced by
the native cflib script and republishes telemetry as standard ROS 2 topics.

Architecture:
    [Native host, unchanged]                    [Docker container]
    cflib --> MQTT broker (192.168.1.84:1883) --> this bridge --> ROS 2 topics

No USB passthrough needed. No changes to existing drone scripts.

ROS 2 topics published per drone:
    /crazyflie/{drone_id}/pose       geometry_msgs/PoseStamped  (x, y, z, yaw→quaternion)
    /crazyflie/{drone_id}/battery    sensor_msgs/BatteryState   (voltage, severity)
    /crazyflie/{drone_id}/status     std_msgs/String            (full JSON payload)

Drone IDs are discovered dynamically from the MQTT topic — no hardcoding needed.
"""

import json
import math
import threading
import time

import paho.mqtt.client as mqtt
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PoseStamped
from sensor_msgs.msg import BatteryState
from std_msgs.msg import String

# ── Config — match your actual setup ──────────────────────────────────────────
MQTT_BROKER_HOST  = "192.168.1.84"   # your Mosquitto broker IP
MQTT_BROKER_PORT  = 1883
# Your drone publishes to: smartcity/cf-e9/telemetry
# Wildcard catches all drones:
MQTT_TOPIC_PATTERN = "smartcity/+/telemetry"
RECONNECT_DELAY_SEC = 5              # seconds between reconnect attempts


def yaw_deg_to_quaternion(yaw_deg: float):
    """Convert yaw in degrees to a quaternion (x, y, z, w).
    Assumes flat flight — roll and pitch are zero.
    ROS uses radians; Crazyflie yaw is in degrees.
    """
    yaw_rad = math.radians(yaw_deg)
    # Quaternion from yaw only: q = [0, 0, sin(yaw/2), cos(yaw/2)]
    return 0.0, 0.0, math.sin(yaw_rad / 2.0), math.cos(yaw_rad / 2.0)


class CrazyflieMqttBridge(Node):
    def __init__(self):
        super().__init__('crazyflie_mqtt_ros2_bridge')

        # Publishers created on first message from each drone — no hardcoding
        self._pose_pubs    = {}
        self._battery_pubs = {}
        self._status_pubs  = {}

        # Declare ROS 2 parameters so they can be overridden at launch time
        # e.g. ros2 run ... --ros-args -p mqtt_host:=192.168.1.50
        self.declare_parameter('mqtt_host', MQTT_BROKER_HOST)
        self.declare_parameter('mqtt_port', MQTT_BROKER_PORT)

        self.get_logger().info('Crazyflie MQTT→ROS2 bridge started')

    def _pubs(self, drone_id: str):
        """Get or create publishers for a drone ID.
        ROS 2 topic names only allow alphanumerics and underscores —
        replace hyphens so cf-e9 becomes cf_e9 in topic names.
        """
        ros_id = drone_id.replace('-', '_')
        if drone_id not in self._pose_pubs:
            ns = f'/crazyflie/{ros_id}'
            self._pose_pubs[drone_id]    = self.create_publisher(PoseStamped, f'{ns}/pose',    10)
            self._battery_pubs[drone_id] = self.create_publisher(BatteryState, f'{ns}/battery', 10)
            self._status_pubs[drone_id]  = self.create_publisher(String,       f'{ns}/status',  10)
            self.get_logger().info(f'Discovered drone: {drone_id} — publishing to {ns}/*')
        return self._pose_pubs[drone_id], self._battery_pubs[drone_id], self._status_pubs[drone_id]

    def handle_telemetry(self, drone_id: str, payload: dict):
        """Parse MQTT payload and publish ROS 2 messages.
        
        Payload fields (from landing_swarm_victim.py):
            x, y, z          — Lighthouse position in meters
            yaw              — heading in degrees (may be None)
            battery          — voltage in volts (may be None)
            timestamp        — ISO 8601 UTC string
            halt             — bool, True if attack detected
            controller       — mission controller identifier
        """
        pose_pub, battery_pub, status_pub = self._pubs(drone_id)
        now = self.get_clock().now().to_msg()

        # ── PoseStamped ────────────────────────────────────────────────────────
        if payload.get('x') is not None:
            msg = PoseStamped()
            msg.header.stamp    = now
            msg.header.frame_id = 'world'
            msg.pose.position.x = float(payload['x'])
            msg.pose.position.y = float(payload['y'])
            msg.pose.position.z = float(payload['z'])

            # Convert yaw to quaternion — default to identity if not available
            yaw = payload.get('yaw')
            if yaw is not None:
                qx, qy, qz, qw = yaw_deg_to_quaternion(float(yaw))
            else:
                qx, qy, qz, qw = 0.0, 0.0, 0.0, 1.0
            msg.pose.orientation.x = qx
            msg.pose.orientation.y = qy
            msg.pose.orientation.z = qz
            msg.pose.orientation.w = qw
            pose_pub.publish(msg)

        # ── BatteryState ───────────────────────────────────────────────────────
        # Field name in your payload is 'battery' not 'battery_voltage'
        bat = payload.get('battery')
        if bat is not None:
            batt_msg = BatteryState()
            batt_msg.header.stamp = now
            batt_msg.voltage      = float(bat)
            # Map your three-tier severity to standard power_supply_status
            # DISCHARGING = 2, not enough constants for three tiers so use
            # percentage as a proxy — ROS consumers can threshold themselves
            batt_msg.percentage   = max(0.0, min(1.0, (float(bat) - 3.0) / (4.2 - 3.0)))
            batt_msg.present      = True
            battery_pub.publish(batt_msg)

            # Log critical battery to ROS console so it appears in ros2 bag
            if float(bat) < 3.2:
                self.get_logger().error(f'{drone_id} BATTERY CRITICAL: {bat:.2f}V — landing imminent')
            elif float(bat) < 3.5:
                self.get_logger().warn(f'{drone_id} battery low: {bat:.2f}V')

        # ── Status (full JSON) — useful for ros2 bag and custom subscribers ────
        status_pub.publish(String(data=json.dumps(payload)))

        # Log halt flag — attack detected by Python mission script
        if payload.get('halt'):
            self.get_logger().error(f'{drone_id} ATTACK DETECTED — mission halted')


def make_mqtt_client(ros_node: CrazyflieMqttBridge):
    def on_connect(client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            ros_node.get_logger().info(
                f'Connected to MQTT broker {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}')
            client.subscribe(MQTT_TOPIC_PATTERN)
            ros_node.get_logger().info(f'Subscribed to: {MQTT_TOPIC_PATTERN}')
        else:
            ros_node.get_logger().error(f'MQTT connection failed: code {reason_code}')

    def on_disconnect(client, userdata, flags, reason_code, properties=None):
        if reason_code != 0:
            ros_node.get_logger().warn(
                f'MQTT disconnected (code {reason_code}) — retrying in {RECONNECT_DELAY_SEC}s')

    def on_message(client, userdata, msg):
        try:
            # Topic: smartcity/cf-e9/telemetry → drone_id = cf-e9
            parts    = msg.topic.split('/')
            drone_id = parts[1] if len(parts) >= 3 else "unknown"
            payload  = json.loads(msg.payload.decode('utf-8'))
            ros_node.handle_telemetry(drone_id, payload)
        except Exception as e:
            ros_node.get_logger().warn(f'Failed to process MQTT message: {e}')

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ros2_bridge")
    client.on_connect    = on_connect
    client.on_disconnect = on_disconnect
    client.on_message    = on_message

    # Auto-reconnect — paho handles this natively with loop_forever()
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    return client


def main():
    rclpy.init()
    bridge = CrazyflieMqttBridge()

    host = bridge.get_parameter('mqtt_host').value
    port = bridge.get_parameter('mqtt_port').value

    mqtt_client = make_mqtt_client(bridge)

    # Retry initial connection — broker might not be ready yet at container start
    connected = False
    while not connected:
        try:
            mqtt_client.connect(host, port, keepalive=60)
            connected = True
        except Exception as e:
            bridge.get_logger().warn(f'Cannot reach MQTT broker: {e} — retrying in {RECONNECT_DELAY_SEC}s')
            time.sleep(RECONNECT_DELAY_SEC)

    # MQTT loop in background thread — ROS 2 spin in main thread
    mqtt_thread = threading.Thread(target=mqtt_client.loop_forever, daemon=True)
    mqtt_thread.start()

    bridge.get_logger().info('Bridge running — waiting for drone telemetry...')
    try:
        rclpy.spin(bridge)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.get_logger().info('Shutting down bridge...')
        mqtt_client.disconnect()
        bridge.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
