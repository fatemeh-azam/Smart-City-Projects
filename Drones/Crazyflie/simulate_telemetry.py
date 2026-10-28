"""
Write simulated telemetry logs so the flight monitor can be tried without drones.

Each drone flies its route from missions.py in real time and writes the same
JSONL format as swarm_mission.py. Two faults can be injected:

  --drift N   Drone N drifts sideways off its route partway through.
  --gap N     Drone N stops sending telemetry for a while, then resumes.

Usage (two terminals):
    python flight_monitor.py --clean
    python simulate_telemetry.py --drift 1 --gap 2

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

import argparse
import json
import math
import time
from datetime import datetime

from missions import CRUISE_HEIGHT, MISSIONS, generate_grid_path, log_filename

SPEED = 0.25        # m/s along the route
PERIOD = 0.6        # s between samples, same as the real logger


def route_points(start, deliveries):
    pts = [start] + [p[:2] for p in generate_grid_path(start, deliveries)] + [start]
    return pts


def position_at(points, distance):
    """Point `distance` metres along a polyline (clamped to the end)."""
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        seg = math.hypot(bx - ax, by - ay)
        if distance <= seg:
            f = 0 if seg == 0 else distance / seg
            return ax + f * (bx - ax), ay + f * (by - ay), False
        distance -= seg
    return points[-1][0], points[-1][1], True


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--drift", type=int, help="drone number that drifts off route")
    p.add_argument("--gap", type=int, help="drone number that goes silent")
    p.add_argument("--gap-start", type=float, default=12.0, help="seconds into the run")
    p.add_argument("--gap-length", type=float, default=10.0, help="seconds of silence")
    p.add_argument("--drift-start", type=float, default=8.0, help="seconds into the run")
    p.add_argument("--drift-length", type=float, default=8.0, help="seconds of drift")
    args = p.parse_args()

    drones = []
    for n, (uri, (start, deliveries)) in enumerate(MISSIONS.items(), start=1):
        fname = log_filename(uri)
        with open(fname, "w") as f:
            f.write("#HEADER: " + json.dumps({"drone_uri": uri, "simulated": True,
                                              "start_time": datetime.now().isoformat()}) + "\n")
        drones.append({"n": n, "file": fname, "points": route_points(start, deliveries),
                       "done": False})
        print(f"Drone {n} -> {fname}")

    t0 = time.time()
    while not all(d["done"] for d in drones):
        elapsed = time.time() - t0
        for d in drones:
            if d["done"]:
                continue
            x, y, d["done"] = position_at(d["points"], SPEED * elapsed)
            if args.drift == d["n"] and args.drift_start <= elapsed < args.drift_start + args.drift_length:
                x += 0.25 * (elapsed - args.drift_start)  # slide sideways up to 2 m
            if args.gap == d["n"] and args.gap_start <= elapsed < args.gap_start + args.gap_length:
                continue
            rec = {"timestamp": time.time(), "datetime": datetime.now().isoformat(),
                   "x": round(x, 3), "y": round(y, 3), "z": CRUISE_HEIGHT,
                   "controller": "SIM"}
            with open(d["file"], "a") as f:
                f.write(json.dumps(rec) + "\n")
        time.sleep(PERIOD)
    print("Simulation finished.")


if __name__ == "__main__":
    main()
