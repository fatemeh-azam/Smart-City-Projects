⚠️ Important: Intended Use & Disclaimer
🚫 This code is for authorized security research and academic purposes only.

Legal Use Only: You must only test on drones you own or have explicit written permission to test.

Laboratory Environment: All demonstrations should be conducted in a controlled, indoor lab with a safety net and protocol.

Not for Malicious Use: This material is provided to help the security and robotics communities understand and mitigate vulnerabilities. The authors are not responsible for any misuse.

Educational Purpose: This repository serves as a companion to our academic publication, providing transparency and enabling reproducibility of our findings to improve platform security


Crazyflie Client-Library Safety Bypass Exploit (HackedHighLevelCommander)
Security Research Repository | Proof of Concept 

This repository contains the exploit code and analysis for a critical client-side safety bypass vulnerability in the official Bitcraze crazyflie-lib-python library. The flaw allows an attacker to hijack control of airborne Crazyflie drones (and swarms) by subverting the library's internal safety mechanisms—without requiring low-level radio packet injection.

Vulnerability Summary
The crazyflie-lib-python library implements concurrency safety (threading locks, state flags like _is_flying) to prevent operational accidents. However, it erroneously treats these safety mechanisms as security boundaries. There is no cryptographic authentication to verify controller legitimacy.

The Core Flaw: An attacker with a modified client library can forcibly bypass these safety locks, set internal state variables, and establish an unauthorized parallel command session, leading to a complete flight control takeover and inducing platform instability ("control chaos").

This is not a radio protocol flaw; it is a client application-layer vulnerability in the security-safety co-design.

Exploit Components
This repository provides two primary exploit classes that demonstrate the vulnerability:

HackedHighLevelCommander (/exploit/hacked_high_level_commander.py):

Purpose: Full-featured, weaponized exploit for reliable swarm hijacking.

Method: Inherits from the standard HighLevelCommander but overrides all safety checks in its __init__ and command methods (e.g., takeoff, go_to, land).

Key Bypass: Forces the _is_flying state to True, starts the SetPointThread without acquiring the safety lock, and sends raw CRTP packets with the high-level command port.

Use Case: Demonstrated for coordinated swarm takeover in our research.

Modified MotionCommander (/exploit/modified_motion_commander.py):

Purpose: Direct adaptation of the initial bypass method described in prior research.

Method: Removes the context manager (__enter__/__exit__), forcibly sets the flying flag, and executes the setpoint thread during initialization.

Key Bypass: Allows connection to and control of an already airborne drone by bypassing the library's concurrency locks.

Use Case: Serves as the foundational proof-of-concept, validating the initial vulnerability step.
