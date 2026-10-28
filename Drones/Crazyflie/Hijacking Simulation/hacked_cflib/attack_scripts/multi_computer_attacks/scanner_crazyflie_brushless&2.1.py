#!/usr/bin/env python3
"""
Crazyflie Drone Detection & Connection Control
==============================================
Author: Fatemeh Azam faa5778@utulsa.edu
Purpose
-------
This script scans for Crazyflie drones using multiple aggressive strategies
designed to detect active drones while ensuring radio and connection cleanup.

Key Features
------------
- Sequential and independent scanning strategies
- Forceful connection teardown to avoid radio lockups
- Drone type inference (CF 2.1 vs Brushless)
- Immediate alerting when a drone is detected
- Designed for lab, education, and controlled testing environments

⚠️ WARNING
----------
This script intentionally opens and forcefully closes radio connections.
Use ONLY in controlled environments with permission.
"""

import time
import logging
import threading
from cflib import crtp
from cflib.crazyflie import Crazyflie

# ---------------------------------------------------------------------------
# Logging Configuration
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Global State
# ---------------------------------------------------------------------------

# Tracks all detected drones during execution
active_drones_detected = []

# ---------------------------------------------------------------------------
# Alerting & Reporting
# ---------------------------------------------------------------------------

def alert_drone_detected(uri, drone_type, method="Unknown"):
    """
    Immediately notify the operator that a drone has been detected.

    Parameters
    ----------
    uri : str
        Crazyflie radio URI
    drone_type : str
        Identified drone type
    method : str
        Detection method used
    """
    print("\n" + "🚨" * 20)
    print("🚨 ACTIVE DRONE DETECTED")
    print(f"🚨 URI: {uri}")
    print(f"🚨 Type: {drone_type}")
    print(f"🚨 Method: {method}")
    print(f"🚨 Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("🚨" * 20 + "\n")

    active_drones_detected.append({
        "uri": uri,
        "type": drone_type,
        "method": method,
        "timestamp": time.time()
    })

# ---------------------------------------------------------------------------
# Forceful Connection Manager
# ---------------------------------------------------------------------------

class ForcefulConnectionManager:
    """
    Manages Crazyflie connections with aggressive teardown logic.

    This class exists to prevent radio lockups caused by partially closed
    connections, especially during rapid scanning.
    """

    def __init__(self):
        self.current_cf = None
        self.connection_lock = threading.Lock()

    def force_disconnect(self, cf, uri=""):
        """
        Forcefully close a Crazyflie connection using multiple fallback methods.

        Parameters
        ----------
        cf : Crazyflie
            Active Crazyflie instance
        uri : str
            Optional URI for logging

        Returns
        -------
        bool
            True if disconnection succeeded
        """
        if cf is None:
            return True

        max_attempts = 3
        disconnected = False

        for attempt in range(max_attempts):
            try:
                if hasattr(cf, "is_connected") and cf.is_connected():
                    print(f"   🔌 Force disconnecting {uri} (attempt {attempt + 1})")

                    # Method 1: Graceful close
                    cf.close_link()
                    time.sleep(0.5)

                    # Method 2: Manual link cleanup if still connected
                    if cf.is_connected():
                        print("   ⚡ Connection persists, forcing link cleanup")
                        cf._link = None
                        time.sleep(0.5)

                    if not cf.is_connected():
                        print("   ✅ Disconnected successfully")
                        disconnected = True
                        break
                else:
                    disconnected = True
                    break

            except Exception as e:
                print(f"   ⚠️ Disconnect error: {e}")

            time.sleep(0.5)

        # Final nuclear option
        if not disconnected:
            print("   💥 Destroying connection object")
            try:
                cf._link = None
            except Exception:
                pass

        return disconnected

    def test_single_connection(self, uri, timeout=3):
        """
        Attempt a short-lived connection to identify a drone.

        Parameters
        ----------
        uri : str
            Crazyflie radio URI
        timeout : int
            Connection timeout in seconds

        Returns
        -------
        str or None
            Drone type if detected, otherwise None
        """
        with self.connection_lock:
            cf = None
            drone_type = None
            event = threading.Event()

            def connected_callback(link_uri):
                nonlocal drone_type
                print(f"      ✅ Connected to {link_uri}")
                try:
                    cf.param.get_value("motorPowerSet.enable")
                    drone_type = "Brushless"
                except Exception:
                    drone_type = "CF 2.1"
                event.set()

            def connection_failed_callback(_, msg):
                print(f"      ❌ Connection failed: {msg}")
                event.set()

            try:
                cf = Crazyflie(rw_cache="./cache")
                self.current_cf = cf

                cf.connected.add_callback(connected_callback)
                cf.connection_failed.add_callback(connection_failed_callback)

                print(f"   Testing {uri}...", end="", flush=True)
                cf.open_link(uri)

                event.wait(timeout)

                self.force_disconnect(cf, uri)

                # Allow radio state to reset
                time.sleep(1.0)
                return drone_type

            except Exception as e:
                print(f"❌ Error: {e}")
                self.force_disconnect(cf, uri)
                time.sleep(1.0)
                return None

            finally:
                self.current_cf = None

# ---------------------------------------------------------------------------
# Scan Strategies
# ---------------------------------------------------------------------------

def quick_sequential_scan():
    """
    Sequentially test known URIs using a single connection manager.

    Recommended default scan method.
    """
    print("🔢 QUICK SEQUENTIAL SCAN")
    print("=" * 40)

    crtp.init_drivers()
    manager = ForcefulConnectionManager()

    test_uris = [
        "radio://0/80/2M/E7E7E7E7E7",
        "radio://0/80/2M/E7E7E7E7E8",
        "radio://0/80/2M/E7E7E7E7E9",
        "radio://0/80/2M/E7E7E7E7EA",
    ]

    found = []

    for i, uri in enumerate(test_uris, 1):
        print(f"\n📍 Testing {i}/{len(test_uris)}: {uri}")
        drone_type = manager.test_single_connection(uri, timeout=2)

        if drone_type:
            found.append({"uri": uri, "type": drone_type})
            alert_drone_detected(uri, drone_type, "sequential_scan")
        else:
            print("   ❌ No response")

        time.sleep(1.5)

    return found

def test_single_drone_independent(uri, timeout=2):
    """
    Test a single drone using a completely fresh Crazyflie instance.

    Most aggressive and isolated scan method.
    """
    cf = None
    connected = False
    drone_type = None

    def connected_callback(_):
        nonlocal connected
        connected = True

    try:
        cf = Crazyflie()
        cf.connected.add_callback(connected_callback)

        print("   Connecting...", end="", flush=True)
        cf.open_link(uri)

        start = time.time()
        while time.time() - start < timeout:
            if connected:
                break
            time.sleep(0.1)

        if connected:
            try:
                cf.param.get_value("motorPowerSet.enable")
                drone_type = "Brushless"
            except Exception:
                drone_type = "CF 2.1"
            print(f" ✅ {drone_type}")
        else:
            print(" ❌")

    finally:
        if cf:
            try:
                cf.close_link()
                cf._link = None
            except Exception:
                pass
        time.sleep(1.5)

    return drone_type

# ---------------------------------------------------------------------------
# Main Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("🚀 CRAZYFLIE DETECTION SYSTEM")
    print("=" * 50)
    print("1. Quick sequential scan (recommended)")
    print("2. Test single drone")

    choice = input("Select option: ").strip()

    if choice == "2":
        uri = input("Enter drone URI: ").strip()
        result = test_single_drone_independent(uri)
        if result:
            alert_drone_detected(uri, result, "single_test")
    else:
        quick_sequential_scan()
