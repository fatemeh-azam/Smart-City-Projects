"""
Smart-city drone delivery mission for a Crazyflie swarm, flown waypoint by waypoint.

Each drone takes off, follows a grid-aligned route through its delivery
points using go_to commands, descends at each one to simulate a drop-off,
then returns to its start point and lands. All drones fly in parallel.
(fly_trajectories.py flies the same routes as one smooth onboard trajectory.)

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

from flight_common import (TAKEOFF_TIME, TelemetryLogger, active_drones, arm, handle_battery,
                           install_kill_switch, preflight_battery, return_and_land,
                           stop_event, wait)
from missions import (CRUISE_HEIGHT, MISSIONS, drone_label, generate_grid_path,
                      is_delivery_point, log_filename)

MOVE_TIME = 8.0         # s allowed for each go_to leg
DELIVERY_TIME = 8.0     # s for each descent and each climb at a drop-off
SETTLE_TIME = 1.5       # s extra after each move to stabilise
DELIVERY_DESCENT = 0.7  # m to drop at each delivery point


def fly_mission(scf, path, start_point, station_id: str) -> None:
    """Fly one drone's route. Runs in parallel for every drone in the swarm."""
    cf, uri = scf.cf, scf._link_uri
    label = drone_label(uri)
    hlc = cf.high_level_commander
    active_drones[uri] = cf

    logger = TelemetryLogger(cf, uri, station_id)
    try:
        logger.start()
        monitor = preflight_battery(cf, label)
        if monitor is None:
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

    install_kill_switch()
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
