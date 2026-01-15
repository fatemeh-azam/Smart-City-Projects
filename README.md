# Smart City Drone Testbed: Secure Autonomous Micro-Aerial Systems

This repository contains a modular smart city testbed designed to study autonomous micro-aerial vehicle (MAV) operations,
cybersecurity vulnerabilities, and real-time anomaly detection in urban infrastructure environments.

The testbed uses Crazyflie micro-drones as a research platform and focuses on secure command-and-control,
trajectory planning, and attack-resilient autonomy.

---

## Project Objectives

- Design autonomous drone missions for smart city use cases (delivery, inspection, monitoring)
- Analyze application-layer vulnerabilities in drone command protocols
- Simulate command injection, hijacking, and spoofing attacks
- Detect anomalous flight behavior caused by cyber attacks
- Explore secure middleware solutions using Rust for real-time command validation

---


## Flight Control

The flight-control/ module implements autonomous mission execution for Crazyflie drones, including:

Grid-based trajectory planning for smart-road environments

Battery-aware mission validation and remaining flight-time estimation

Predefined waypoint missions with controlled takeoff, delivery descent, and return-to-base logic

Integration with the Crazyflie Light House Positioning System 

This module serves as the baseline for normal, expected drone behavior.

## Anomaly Detection

The anomaly-detection/ module monitors live telemetry and compares actual drone behavior against expected trajectories.

Key capabilities include:

Real-time trajectory deviation detection

Velocity and position threshold analysis

Detection of unexpected command frequency or sudden path changes

Logging of anomalous events for post-flight analysis

This module is used to identify deviations caused by faults or active cyber attacks.

## Hijacking Simulation

The hijacking-simulation/ module demonstrates application-layer vulnerabilities in the Crazyflie control protocol.

Implemented attack scenarios include:

Simultaneous connection of multiple Crazyradios to a single drone

Command flooding to override legitimate flight controllers

Spoofing of waypoint coordinates mid-flight

Forced trajectory deviation and mission disruption

This module provides realistic attack data for evaluating detection and mitigation strategies.

Secure Middleware (In Progress)

The security/ module contains an in-progress Rust-based secure commander middleware designed to:

Act as a mandatory command-validation gateway

Enforce cryptographic authentication of flight commands

Prevent unauthorized controllers from injecting commands

Rate-limit command traffic and detect malicious patterns

This work extends the hijacking simulations toward real-world defense mechanisms.

## Experimental Setup

Crazyflie Brushless micro-drones

Crazyradio PA

Lighthouse Positioning System (LPS)

## 📊 Applications & Use Cases

Smart road and delivery simulations

Secure autonomous fleet research

Cybersecurity education and training

UAV attack detection and response evaluation
