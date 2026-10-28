"""
Shared pieces for the flight scripts: telemetry logging, battery handling,
return-to-base, and the Ctrl+C kill switch.

Used by swarm_mission.py (waypoint missions) and fly_trajectories.py
(onboard trajectory missions), so both log, react to the battery, and stop
the same way.

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import json
import queue
import signal
import sys
import threading
import time
from datetime import datetime

from battery_monitor import BatteryMonitor, FlightDecision
from missions import CRUISE_HEIGHT, MISSIONS, drone_label, log_filename

TAKEOFF_TIME = 2.0      # s
RETURN_TIME = 10.0      # s to fly back to the start point
LAND_TIME = 6.0         # s
POSITION_LOG_MS = 600   # telemetry period

stop_event = threading.Event()
active_drones = {}      # uri -> Crazyflie, for the kill switch
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
        self._stopped = False

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
        loggers[self.uri] = self
        print(f"[{drone_label(self.uri)}] logging position to {self.filename}")

    def _on_position(self, timestamp, data, logconf) -> None:
        record = {
            "timestamp": time.time(),
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
        if self._stopped:
            return
        self._stopped = True
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
        loggers.pop(self.uri, None)


# ----------------------------------------------------------------------
# Flight helpers
# ----------------------------------------------------------------------

def wait(seconds: float) -> bool:
    """Sleep, waking early on emergency stop. Returns False if stopped."""
    return not stop_event.wait(seconds)


def arm(scf) -> None:
    scf.cf.platform.send_arming_request(True)
    time.sleep(1.0)


def set_controller(scf, name: str) -> None:
    """Select the onboard controller: "pid" or "mellinger"."""
    scf.cf.param.set_value("stabilizer.controller", {"pid": 1, "mellinger": 2}[name])
    time.sleep(0.5)


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


def preflight_battery(cf, label: str):
    """Start battery telemetry and check it's safe to take off.

    Returns the running BatteryMonitor, or None if the drone shouldn't fly.
    """
    monitor = BatteryMonitor(cf)
    monitor.start()
    if not monitor.wait_for_data(timeout=3.0):
        print(f"[{label}] no battery telemetry, not taking off")
        return None
    if monitor.flight_decision() > FlightDecision.CONTINUE:
        print(f"[{label}] battery too low to start ({monitor.voltage:.2f} V)")
        return None
    return monitor


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


def install_kill_switch() -> None:
    signal.signal(signal.SIGINT, emergency_stop)
