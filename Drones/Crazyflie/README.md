# Crazyflie Delivery Testbed

Software for flying multi-drone delivery missions on a small indoor smart-city
testbed, and for monitoring those flights in real time. It runs on Bitcraze
Crazyflie drones with the Loco Positioning System, and was built at the
Oklahoma Cyber Innovation Institute (University of Tulsa) as the flight side of
our micro-UAV security research.

![Flight monitor with one drone off route and one with a telemetry gap](docs/flight-monitor.png)

## What's here

| File | What it does |
| --- | --- |
| `missions.py` | Start points and delivery points for each drone, plus the route generator. Every other script reads routes from here. |
| `swarm_mission.py` | Flies every drone in parallel along its delivery route with one `go_to` command per leg, a descent at each drop-off, battery checks before every leg, and buffered telemetry logging. |
| `fly_trajectories.py` | Flies the same routes as one smooth trajectory per drone, uploaded to the drone and flown onboard, with the ground station still watching the battery. |
| `trajectories.py` | Builds, checks, evaluates, saves and uploads 7th-order polynomial trajectories in the Crazyflie format. |
| `plot_trajectory.py` | Top view, 3D view and height-over-time plots for the mission trajectories or any trajectory CSV. |
| `battery_monitor.py` | A small library on top of the Crazyflie's power telemetry. Returns a continue / return-to-base / land decision and estimates remaining flight time from a recorded discharge. |
| `flight_monitor.py` | Rule-based monitor. Flags drones that leave their route or stop sending telemetry, records each outage, and shows a live map with an event log. |
| `flight_common.py` | Shared by both flight scripts: telemetry logging, battery handling, return-to-base and the kill switch. |
| `simulate_telemetry.py` | Writes realistic telemetry logs, with optional drift and dropouts, so the monitor can be tried without drones. |

## Try it without drones

```bash
pip install -r requirements.txt

# terminal 1
python flight_monitor.py --clean

# terminal 2: drone 1 drifts off route, drone 2 goes silent for 10 s
python simulate_telemetry.py --drift 1 --gap 2
```

```bash
python swarm_mission.py --dry-run      # print each drone's route, no radio needed
python fly_trajectories.py --dry-run   # print each drone's trajectory segments
python plot_trajectory.py              # plot the mission trajectories
python -m pytest                       # run the tests
```

## Flying a mission

You need Crazyflie 2.x drones, a Crazyradio, and a calibrated Loco Positioning
System. Edit `missions.py` to match your space:

```python
MISSIONS = {
    "radio://0/80/2M/E7E7E7E7E9": (
        (0.4, -1.85),                                   # start point (x, y) in metres
        [(0.85, -1.24), (0.85, -0.78), (0.85, 0.95)],   # delivery points, in order
    ),
}
```

Each drone flies along its "street" (the start point's x coordinate), turns off
to reach a delivery point when it isn't on the street, descends 0.7 m to
simulate the drop-off, climbs back, and continues. When the route is done it
flies back to the start point and lands.

There are two ways to fly the same routes:

```bash
python flight_monitor.py --clean   # optional: start the monitor first

python swarm_mission.py            # waypoint by waypoint, one go_to per leg
python fly_trajectories.py         # one smooth onboard trajectory per drone
```

| | `swarm_mission.py` | `fly_trajectories.py` |
| --- | --- | --- |
| How the route is sent | A `go_to` command for every leg | The whole route uploaded once, flown onboard |
| Motion | Stops and settles at every waypoint | Continuous, with smooth corners and drop-offs |
| Mission time (drone 1), takeoff to landing | About 2 min 45 s | About 1 min 15 s |
| Battery checks | Before every leg | Every 0.5 s during the trajectory |
| Change the route mid-flight | Easy: the next command can differ | Needs a new upload |

Both write the same telemetry logs, so the flight monitor works with either.

**Safety.** There is no obstacle avoidance; check every route against the room
before flying. **Ctrl+C is a kill switch**: it cuts the motors on every drone
immediately, so fly over a net or soft floor.

## Trajectories

![Both delivery missions as smooth trajectories](docs/delivery-trajectories.png)

The Crazyflie's high-level commander can store a trajectory onboard and fly
it by itself. A trajectory is a list of segments, each a 7th-order polynomial
in time for x, y, z and yaw.

`trajectories.delivery_trajectory()` turns a mission from `missions.py` into
one. Every leg is a rest-to-rest polynomial: the drone starts and stops each
leg with zero velocity, acceleration and jerk, so it rounds the grid's
90-degree corners smoothly. At each delivery point it descends to 0.3 m,
hovers for a second and climbs back. Leg durations come from a peak-speed
limit (`--max-speed`, 0.5 m/s by default; 0.4 m/s vertically).

```python
from trajectories import delivery_trajectory, save_csv, upload, describe

segs = delivery_trajectory((0.4, -1.85), [(0.85, -1.24), (0.85, 0.95)])
print(describe(segs))            # segments, total time, peak speed
save_csv("drone1.csv", segs)
upload(cf, segs, trajectory_id=1)
cf.high_level_commander.start_trajectory(1)
```

`upload()` refuses a trajectory with a gap between segments, or one longer
than the drone's trajectory memory holds. The standard 4 KB memory holds 31
segments; the drone 1 mission uses 19.

```bash
python plot_trajectory.py                        # mission trajectories
python plot_trajectory.py examples/figure8.csv   # any trajectory file
python fly_trajectories.py --export-csv out/     # save the mission trajectories
```

### Trajectory file format

One segment per row, 33 numbers, with an optional header row:

```
duration, x^0 … x^7, y^0 … y^7, z^0 … z^7, yaw^0 … yaw^7
```

Within a segment, with `t` from 0 to `duration` seconds:

```
x(t) = x^0 + x^1·t + x^2·t² + … + x^7·t⁷
```

and the same for y, z and yaw (radians). Segments run back to back, so each
starts where the previous one ended. This is the layout Bitcraze's tools use.

`examples/figure8.csv` is the figure-8 from Bitcraze's crazyflie-lib-python
examples. Its height coefficients are all zero because it is meant to be flown
relative to the drone's hover position
(`start_trajectory(id, relative_position=True)`).

## Battery monitor

```python
from battery_monitor import BatteryMonitor, FlightDecision

monitor = BatteryMonitor(cf)          # thresholds come from pm.lowVoltage / pm.criticalLowVoltage
monitor.start()                       # stream power telemetry every 500 ms
if not monitor.wait_for_data():
    raise RuntimeError("no battery telemetry")

decision = monitor.flight_decision()
monitor.status()                      # voltage, %, state, health, suggested action
```

| Condition | Health | Decision |
| --- | --- | --- |
| No telemetry yet | `NO_DATA` | `LAND` (refuse to take off) |
| Firmware reports shutdown, or voltage at or below critical | `SHUTDOWN` / `CRITICAL` | `LAND` |
| Firmware reports low power, or voltage at or below low | `LOW_POWER` / `WARNING` | `RETURN_TO_BASE` |
| Otherwise | `NORMAL` | `CONTINUE` |

`FlightDecision` is an `IntEnum` ordered by urgency, so `decision > FlightDecision.CONTINUE`
means "don't carry on as planned".

**Remaining flight time.** Record one full discharge (a hover or a typical
mission flown until the low-voltage cutoff). The monitor bins voltage to 0.01 V
and stores the average time left at each level:

```python
monitor.record_discharge("discharge_log.csv", duration_s=360)   # runs in the background
# ... later, or in another session:
monitor.load_lookup_from_discharge("discharge_log.csv")
monitor.estimate_remaining_time()       # seconds, from the current voltage
```

Voltage sags under load, so the estimate is only as good as how closely the
recording matches the flight. Record under similar conditions.

`auto_land_if_needed(reserve_s=30)` combines the two for standalone use: it lands
at once on a critical battery, and on a low battery when less than `reserve_s`
of flight is left.

## Flight monitor

The monitor applies two fixed-threshold rules to every drone. They are
deliberately simple: they make a transparent baseline to compare learned
detectors against.

**Off route.** The monitor tracks which waypoint each drone should be heading
to and advances when the drone comes within 0.3 m of it. A drone is off route
if it is further than the tolerance for the current leg (1.0 m on the first leg
and the last two, 0.8 m otherwise), or if it moves faster than 2 m/s between
samples.

**Telemetry gap.** Time since the newest sample: warning after 2 s, alarm after
4 s, critical after 8 s. Alarms repeat every 10 s and critical alerts every 5 s
while the gap lasts. Each outage is recorded with its start time, how long it
took to reach critical, and its total length. They're printed on exit, and
`--outages-csv` saves them.

All thresholds live in the `Thresholds` dataclass at the top of `flight_monitor.py`.

| Option | Effect |
| --- | --- |
| `--path-metric target` | Distance to the next waypoint (default; the original rule). |
| `--path-metric segment` | Distance to the line between the previous and next waypoint. |
| `--route-check URI ...` | Apply the route rule only to these drones. |
| `--clean` | Delete old telemetry logs before starting. |
| `--outages-csv FILE` | Save outage metrics on exit. |
| `--no-plot` | Console output only. |

**Known limitation of the default rule.** Measuring distance to the next
waypoint flags a drone that is exactly on route whenever a leg is longer than
the tolerance. In a simulated perfect flight of the two missions in
`missions.py` (0.22 m/s, one sample every 0.6 s), about 30% of samples are
flagged, all on the long legs. `--path-metric segment`
removes these false alarms and keeps the same tolerances. The original rule
stays the default so earlier results can be reproduced.

## Telemetry log format

`swarm_mission.py` writes one JSON Lines file per drone,
`drone_position_<uri>.jsonl`, which the monitor reads as it grows:

```
#HEADER: {"drone_uri": "radio://0/80/2M/E7E7E7E7E9", "start_time": "...", "mission": [[0.85, -1.24], ...]}
{"timestamp": 1761660000.12, "datetime": "2026-10-28T10:00:00.120", "x": 0.40, "y": -1.80, "z": 0.98, "controller": "CTR-7F3A9C"}
...
{"timestamp": 1761660120.50, "event": "logging_stopped", "stats": {"messages": 198, "dropped": 0}}
```

Position comes from the onboard state estimate every 600 ms. The radio
callback only puts lines on a queue; a background thread writes them to disk,
so slow writes never hold up the link. `controller` is the ground-station ID
(`--station-id`), and the monitor warns if it changes mid-flight.

## Author

Fatemeh Azam, Oklahoma Cyber Innovation Institute, University of Tulsa.
