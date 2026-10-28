"""
Smart-city drone delivery mission for a Crazyflie swarm.

Each drone takes off, follows a grid-aligned route through its delivery
points, descends at each one to simulate a drop-off, then returns to its
start point and lands. All drones fly in parallel.

Along the way:
- the battery is checked before every leg; a low battery sends the drone
  home, a critical one lands it where it is (see battery_monitor.py);
- position telemetry is written to one JSONL file per drone by a background
  thread, so slow disk writes never stall the radio link. The flight monitor
  (flight_monitor.py) reads these files live.

Assumptions:
- Positioning comes from the Loco Positioning System (LPS).
- There is no obstacle avoidance. Routes and delivery points in missions.py
  must be checked against the physical testbed before flying.

Ctrl+C is a kill switch: it cuts the motors on every drone immediately.

Usage:
    python swarm_mission.py              # fly every mission in missions.py
    python swarm_mission.py --dry-run    # print the routes, no radio needed

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import argparse
import json
import queue
import signal
import sys
import threading
import time
from datetime import datetime

from battery_monitor import BatteryMonitor, FlightDecision
from missions import (CRUISE_HEIGHT, MISSIONS, drone_label, generate_grid_path,
                      is_delivery_point, log_filename)

# --- Timing and geometry -------------------------------------------------
TAKEOFF_TIME = 2.0      # s
MOVE_TIME = 8.0         # s allowed for each go_to leg
DELIVERY_TIME = 8.0     # s for each descent and each climb at a drop-off
RETURN_TIME = 10.0      # s to fly back to the start point
LAND_TIME = 6.0         # s
SETTLE_TIME = 1.5       # s extra after each move to stabilise
DELIVERY_DESCENT = 0.7  # m to drop at each delivery point
POSITION_LOG_MS = 600   # telemetry period

stop_event = threading.Event()
active_drones = {}      # uri -> Crazyflie
loggers = {}            # uri -> TelemetryLogger


# ----------------------------------------------------------------------
# Telemetry logging
# ----------------------------------------------------------------------

class TelemetryLogger:
    """Streams position estimates to a JSONL file without blocking the radio.

    The cflib callback only puts a line on a bounded queue; a writer thread
    batches lines to disk. If the queue fills, samples are dropped and
    counted rather than slowing down the callback.

    File format (one JSON object per line):
        #HEADER: {"drone_uri": ..., "start_time": ..., "mission": [...]}
        {"timestamp": 1730000000.12, "datetime": "...", "x": .., "y": .., "z": .., "controller": "..."}
        ...
        {"timestamp": ..., "event": "logging_stopped", "stats": {...}}
    """

    def __init__(self, cf, uri: str, station_id: str,
                 batch_size: int = 5, flush_interval: float = 0.2):
        self.cf, self.uri, self.station_id = cf, uri, station_id
        self.filename = log_filename(uri)
        self.batch_size, self.flush_interval = batch_size, flush_interval
        self.queue: queue.Queue = queue.Queue(maxsize=200)
        self.stats = {"messages": 0, "dropped": 0}
        self._running = threading.Event()
        self._thread = None
        self._log_conf = None

    def start(self) -> None:
        from cflib.crazyflie.log import LogConfig

        with open(self.filename, "w") as f:
            header = {"drone_uri": self.uri,
                      "start_time": datetime.now().isoformat(),
                      "mission": MISSIONS.get(self.uri, (None, []))[1]}
            f.write(f"#HEADER: {json.dumps(header)}\n")

        self._running.set()
        self._thread = threading.Thread(target=self._writer, daemon=True)
        self._thread.start()

        conf = LogConfig(name="Position", period_in_ms=POSITION_LOG_MS)
        for axis in "xyz":
            conf.add_variable(f"stateEstimate.{axis}", "float")
        conf.data_received_cb.add_callback(self._on_position)
        self.cf.log.add_config(conf)
        conf.start()
        self._log_conf = conf
        print(f"[{drone_label(self.uri)}] logging position to {self.filename}")

    def _on_position(self, timestamp, data, logconf) -> None:
        now = time.time()
        record = {
            "timestamp": now,
            "datetime": datetime.now().isoformat(),
            "x": float(data["stateEstimate.x"]),
            "y": float(data["stateEstimate.y"]),
            "z": float(data["stateEstimate.z"]),
            "controller": self.station_id,
        }
        self.stats["messages"] += 1
        try:
            self.queue.put_nowait(json.dumps(record))
        except queue.Full:
            self.stats["dropped"] += 1

    def _writer(self) -> None:
        batch, last_flush = [], time.time()
        with open(self.filename, "a") as f:
            while self._running.is_set() or not self.queue.empty():
                try:
                    batch.append(self.queue.get(timeout=0.5))
                    self.queue.task_done()
                except queue.Empty:
                    pass
                if batch and (len(batch) >= self.batch_size
                              or time.time() - last_flush >= self.flush_interval):
                    f.write("\n".join(batch) + "\n")
                    f.flush()
                    batch.clear()
                    last_flush = time.time()
            if batch:
                f.write("\n".join(batch) + "\n")

    def stop(self) -> None:
        """Stop telemetry, flush everything queued, and write an end marker."""
        if self._log_conf is not None:
            try:
                self._log_conf.stop()
            except Exception:
                pass
            self._log_conf = None
        self._running.clear()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None
        with open(self.filename, "a") as f:
            f.write(json.dumps({"timestamp": time.time(),
                                "datetime": datetime.now().isoformat(),
                                "event": "logging_stopped",
                                "stats": self.stats}) + "\n")


# ----------------------------------------------------------------------
# Flight helpers
# ----------------------------------------------------------------------

def wait(seconds: float) -> bool:
    """Sleep, waking early on emergency stop. Returns False if stopped."""
    return not stop_event.wait(seconds)


def arm(scf) -> None:
    scf.cf.platform.send_arming_request(True)
    time.sleep(1.0)


def return_and_land(hlc, start_point, label: str) -> None:
    print(f"[{label}] returning to start")
    hlc.go_to(start_point[0], start_point[1], CRUISE_HEIGHT, 0, RETURN_TIME)
    if wait(RETURN_TIME + 1):
        hlc.land(0.0, LAND_TIME)
        wait(LAND_TIME + 1)


def handle_battery(monitor: BatteryMonitor, hlc, start_point, label: str) -> bool:
    """Act on the battery decision. Returns True if the mission must end."""
    decision = monitor.flight_decision()
    if decision is FlightDecision.LAND:
        print(f"[{label}] battery critical ({monitor.voltage:.2f} V), landing now")
        hlc.land(0.0, 3.0)
        wait(4)
        return True
    if decision is FlightDecision.RETURN_TO_BASE:
        print(f"[{label}] battery low ({monitor.voltage:.2f} V), heading home")
        return_and_land(hlc, start_point, label)
        return True
    return False


def fly_mission(scf, path, start_point, station_id: str) -> None:
    """Fly one drone's route. Runs in parallel for every drone in the swarm."""
    cf, uri = scf.cf, scf._link_uri
    label = drone_label(uri)
    hlc = cf.high_level_commander
    active_drones[uri] = cf

    logger = TelemetryLogger(cf, uri, station_id)
    loggers[uri] = logger
    try:
        logger.start()

        monitor = BatteryMonitor(cf)
        monitor.start()
        if not monitor.wait_for_data(timeout=3.0):
            print(f"[{label}] no battery telemetry, not taking off")
            return
        if monitor.flight_decision() > FlightDecision.CONTINUE:
            print(f"[{label}] battery too low to start ({monitor.voltage:.2f} V)")
            return

        hlc.takeoff(CRUISE_HEIGHT, TAKEOFF_TIME)
        if not wait(TAKEOFF_TIME + 1):
            return

        for x, y, z, yaw in path:
            if stop_event.is_set() or handle_battery(monitor, hlc, start_point, label):
                return

            print(f"[{label}] flying to ({x:.2f}, {y:.2f})")
            hlc.go_to(x, y, z, yaw, MOVE_TIME)
            if not wait(MOVE_TIME + SETTLE_TIME):
                return

            if is_delivery_point(uri, x, y):
                print(f"[{label}] delivering at ({x:.2f}, {y:.2f})")
                hlc.go_to(x, y, z - DELIVERY_DESCENT, yaw, DELIVERY_TIME)
                if not wait(DELIVERY_TIME + SETTLE_TIME):
                    return
                hlc.go_to(x, y, z, yaw, DELIVERY_TIME)
                if not wait(DELIVERY_TIME + SETTLE_TIME):
                    return

        if not stop_event.is_set():
            return_and_land(hlc, start_point, label)
            print(f"[{label}] mission complete")
    finally:
        logger.stop()
        active_drones.pop(uri, None)


# ----------------------------------------------------------------------
# Kill switch
# ----------------------------------------------------------------------

def emergency_stop(sig=None, frame=None) -> None:
    """Ctrl+C: cut motors on every drone, flush logs, exit."""
    print("\nEMERGENCY STOP: cutting motors on all drones")
    stop_event.set()
    for uri, cf in list(active_drones.items()):
        try:
            cf.commander.send_stop_setpoint()
        except Exception as e:
            print(f"  could not stop {uri}: {e}")
    for logger in list(loggers.values()):
        try:
            logger.stop()
        except Exception:
            pass
    sys.exit(1)


# ----------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Fly the delivery missions defined in missions.py.")
    parser.add_argument("--dry-run", action="store_true",
                        help="print each drone's route and exit without connecting")
    parser.add_argument("--station-id", default="CTR-7F3A9C",
                        help="ground-station ID written into every telemetry record")
    args = parser.parse_args()

    routes = {uri: generate_grid_path(start, deliveries)
              for uri, (start, deliveries) in MISSIONS.items()}

    for uri, route in routes.items():
        print(f"{drone_label(uri)} ({uri}): start {MISSIONS[uri][0]}")
        for x, y, z, _ in route:
            tag = "  delivery" if is_delivery_point(uri, x, y) else ""
            print(f"    -> ({x:.2f}, {y:.2f}, {z:.2f}){tag}")
    if args.dry_run:
        return

    import cflib.crtp
    from cflib.crazyflie.swarm import CachedCfFactory, Swarm

    signal.signal(signal.SIGINT, emergency_stop)
    cflib.crtp.init_drivers()

    factory = CachedCfFactory(rw_cache="./cache")
    with Swarm(list(MISSIONS), factory=factory) as swarm:
        swarm.reset_estimators()
        swarm.parallel_safe(arm)
        print("Mission started. Ctrl+C cuts all motors.")
        swarm.parallel_safe(fly_mission, args_dict={
            uri: [routes[uri], MISSIONS[uri][0], args.station_id] for uri in routes
        })
    print("All drones done. Logs:", ", ".join(log_filename(u) for u in MISSIONS))


if __name__ == "__main__":
    main()
