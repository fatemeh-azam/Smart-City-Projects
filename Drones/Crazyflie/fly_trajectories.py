"""
Fly the delivery missions as smooth onboard trajectories.

Same routes as swarm_mission.py, but instead of sending a go_to command for
every leg, each drone gets its whole route uploaded as a polynomial
trajectory (see trajectories.py) and flies it on its own. The result is a
continuous, smooth flight with gentle corners and drop-offs.

While a trajectory runs, the ground station still checks the battery every
half second and can send a drone home or land it, and telemetry is logged
for the flight monitor exactly as in swarm_mission.py.

Ctrl+C is a kill switch: it cuts the motors on every drone immediately.

Usage:
    python fly_trajectories.py --dry-run           # print segments, no radio needed
    python fly_trajectories.py --plot              # also plot the trajectories
    python fly_trajectories.py --export-csv out/   # save each trajectory as CSV
    python fly_trajectories.py                     # upload and fly

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import argparse
import os
import time

from flight_common import (LAND_TIME, TAKEOFF_TIME, TelemetryLogger, active_drones, arm,
                           handle_battery, install_kill_switch, preflight_battery,
                           set_controller, stop_event, wait)
from missions import CRUISE_HEIGHT, MISSIONS, drone_label, log_filename
from trajectories import delivery_trajectory, describe, save_csv, total_duration, upload

TRAJECTORY_ID = 1
ALIGN_TIME = 2.0        # s to settle exactly on the trajectory's start point
CHECK_EVERY = 0.5       # s between battery checks during the trajectory


def upload_for(scf, segments) -> None:
    duration = upload(scf.cf, segments, TRAJECTORY_ID)
    print(f"[{drone_label(scf._link_uri)}] uploaded {len(segments)} segments ({duration:.1f} s)")


def fly(scf, segments, start_point, station_id: str, controller: str) -> None:
    cf, uri = scf.cf, scf._link_uri
    label = drone_label(uri)
    hlc = cf.high_level_commander
    active_drones[uri] = cf

    logger = TelemetryLogger(cf, uri, station_id)
    try:
        logger.start()
        set_controller(scf, controller)
        monitor = preflight_battery(cf, label)
        if monitor is None:
            return

        hlc.takeoff(CRUISE_HEIGHT, TAKEOFF_TIME)
        if not wait(TAKEOFF_TIME + 1):
            return
        sx, sy, sz = segments[0].start
        hlc.go_to(sx, sy, sz, 0, ALIGN_TIME)
        if not wait(ALIGN_TIME + 0.5):
            return

        duration = total_duration(segments)
        print(f"[{label}] starting trajectory ({duration:.1f} s)")
        hlc.start_trajectory(TRAJECTORY_ID, relative_position=False)
        end = time.time() + duration
        while time.time() < end:
            # A go_to or land from handle_battery overrides the running trajectory.
            if stop_event.is_set() or handle_battery(monitor, hlc, start_point, label):
                return
            if not wait(min(CHECK_EVERY, max(0.0, end - time.time()))):
                return

        hlc.land(0.0, LAND_TIME)
        wait(LAND_TIME + 1)
        hlc.stop()
        print(f"[{label}] mission complete")
    finally:
        logger.stop()
        active_drones.pop(uri, None)


def main() -> None:
    p = argparse.ArgumentParser(description="Fly the missions in missions.py as onboard trajectories.")
    p.add_argument("--dry-run", action="store_true", help="print the trajectories and exit")
    p.add_argument("--plot", action="store_true", help="plot the trajectories before flying")
    p.add_argument("--export-csv", metavar="DIR", help="save each trajectory as a CSV file")
    p.add_argument("--max-speed", type=float, default=0.5, help="peak horizontal speed, m/s")
    p.add_argument("--controller", choices=["pid", "mellinger"], default="mellinger",
                   help="onboard controller used to track the trajectory")
    p.add_argument("--station-id", default="CTR-7F3A9C",
                   help="ground-station ID written into every telemetry record")
    args = p.parse_args()

    trajs = {uri: delivery_trajectory(start, deliveries, max_speed=args.max_speed)
             for uri, (start, deliveries) in MISSIONS.items()}
    for uri, segs in trajs.items():
        print(describe(segs, f"{drone_label(uri)} ({uri})"))

    if args.export_csv:
        os.makedirs(args.export_csv, exist_ok=True)
        for uri, segs in trajs.items():
            path = os.path.join(args.export_csv, f"{drone_label(uri).replace(' ', '_').lower()}.csv")
            save_csv(path, segs)
            print(f"saved {path}")
    if args.plot:
        from plot_trajectory import plot
        plot({drone_label(u): s for u, s in trajs.items()},
             starts={drone_label(u): MISSIONS[u][0] for u in MISSIONS},
             deliveries={drone_label(u): MISSIONS[u][1] for u in MISSIONS})
    if args.dry_run:
        return

    import cflib.crtp
    from cflib.crazyflie.swarm import CachedCfFactory, Swarm

    install_kill_switch()
    cflib.crtp.init_drivers()
    factory = CachedCfFactory(rw_cache="./cache")
    with Swarm(list(MISSIONS), factory=factory) as swarm:
        swarm.parallel_safe(upload_for, args_dict={u: [trajs[u]] for u in trajs})
        swarm.reset_estimators()
        swarm.parallel_safe(arm)
        print("Mission started. Ctrl+C cuts all motors.")
        swarm.parallel_safe(fly, args_dict={
            u: [trajs[u], MISSIONS[u][0], args.station_id, args.controller] for u in trajs
        })
    print("All drones done. Logs:", ", ".join(log_filename(u) for u in MISSIONS))


if __name__ == "__main__":
    main()
