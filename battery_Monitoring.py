#The BatteryMonitor class monitors the battery status of a Crazyflie drone in real time
#using logging data. It evaluates battery health, warns about critical conditions, and
#can automatically initiate a controlled or emergency landing if battery levels drop
#too low.
#Author:
#    Fatemeh Azam
#    Email: faa5778@utulsa.edu
"""
BatteryMonitor Class

Purpose:
    Monitors and manages the battery status of a Crazyflie drone by 
    receiving real-time power management data via Crazyflie's logging system.
    Provides health checks, warnings, and can trigger automatic landing
    procedures based on battery conditions.

Functions:

    __init__(cf)
        - Initialize the BatteryMonitor with a Crazyflie instance.
        - Sets up default battery parameters and thresholds.
    
    setup_logging()
        - Configures and starts logging of relevant battery parameters 
          (voltage, current, battery level, etc.) from the Crazyflie.
        - Registers the callback to process incoming log data.

    log_callback(timestamp, data, logconf)
        - Processes incoming log data from the Crazyflie.
        - Maps raw log keys to internal battery data keys and updates state.

    check_systems()
        - Analyzes current battery data and returns a status dictionary containing:
          voltage, charge percentage, battery state, charging status, 
          health status, and suggested actions (e.g., land immediately).

    _get_state_string()
        - Converts numeric battery state codes to human-readable strings.

    _get_health_status()
        - Determines overall battery health status based on voltage and state.

    auto_land_if_needed()
        - Checks battery status and automatically initiates a controlled or 
          emergency landing if battery voltage is critical or low.

    estimate_remaining_time()
        - Provides a simple estimation of remaining flight time based on voltage 
          and discharge current (simplified linear model).

    _perform_controlled_landing()
        - Executes a gradual, controlled landing sequence by progressively lowering altitude.

    _perform_emergency_landing()
        - Executes an immediate stop command to land the drone urgently.
"""

from cflib.crazyflie import Crazyflie
from cflib.crazyflie.log import LogConfig
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
import time

class BatteryMonitor:
    def __init__(self, cf):
        self.cf = cf
        self.current_data = {
            'vbat': 0.0, # Battery voltage (V)
            'vbatMV': 0, # Battery voltage (mV)
            'state': 0, # PM state (0=battery, 1=charging, etc.)
            'batteryLevel': 0, # Charge percentage
            'chargeCurrent': 0.0, # Charging current (A)
            'extVbat': 0.0, # External voltage (V) (BigQuad)
            'extCurr': 0.0 # External current (A) (BigQuad)
        }
        self.landing_initiated = False
        #self._setup_logging()
        
        # Battery parameters from PM group
        self.low_voltage = float(cf.param.get_value('pm.lowVoltage'))
        self.critical_voltage = float(cf.param.get_value('pm.criticalLowVoltage'))
        
        # Battery characteristics (Based on Crazyfli release and version)
        self.FULL_VOLTAGE = 4.2 # Fully charged voltage
        self.MAX_DISCHARGE_RATE = 2.0 # Max safe discharge current (A)


    def log_callback(self, timestamp, data, logconf):
        print(f"[{timestamp}] Callback fired!")
       
        # Mapping from incoming log keys to battery monitoring internal keys
        mapping = {
        'pm.vbat': 'vbat',
        'pm.vbatMV': 'vbatMV',
        'pm.state': 'state',
        'pm.batteryLevel': 'batteryLevel',
        'pm.chargeCurrent': 'chargeCurrent',
        'pm.extVbat': 'extVbat',
        'pm.extCurr': 'extCurr'
        }
        for raw_key, value in data.items():
            if raw_key in mapping:
                self.current_data[mapping[raw_key]] = value
        print(f"Updated data: {self.current_data}")

    def setup_logging(self):
        log_conf = LogConfig(name='CrazyflieBattery', period_in_ms=500)
        
        # Add all relevant PM log variables
        log_conf.add_variable('pm.vbat', 'float')
        log_conf.add_variable('pm.vbatMV', 'uint16_t')
        log_conf.add_variable('pm.state', 'int8_t')
        log_conf.add_variable('pm.batteryLevel', 'uint8_t')
        log_conf.add_variable('pm.chargeCurrent', 'float')
        log_conf.add_variable('pm.extVbat', 'float')
        log_conf.add_variable('pm.extCurr', 'float')
        
        
        log_conf.data_received_cb.add_callback(self.log_callback)

        self.cf.log.add_config(log_conf)
        log_conf.start()
        self.log_conf = log_conf
        print("logging started")
        
    def check_systems(self):
        """Check all battery-related systems and return status dict"""
        status = {
            'voltage': self.current_data['vbat'],
            'percentage': self.current_data['batteryLevel'],
            'state': self._get_state_string(),
            'charging': self.current_data['state'] in (1, 2),
            'health_status': self._get_health_status(),
            'suggested_action': None
        }
        
        # Check for critical conditions
        if self.current_data['vbat'] <= self.critical_voltage:
            status['health_status'] = 'CRITICAL'
            status['suggested_action'] = 'LAND_IMMEDIATELY'
        elif self.current_data['vbat'] <= self.low_voltage:
            status['health_status'] = 'WARNING'
            status['suggested_action'] = 'PREPARE_TO_LAND'
            
        # Check for abnormal discharge
        if (self.current_data['extCurr'] > self.MAX_DISCHARGE_RATE and 
            not status['charging']):
            status['health_status'] = 'WARNING'
            status['suggested_action'] = 'REDUCE_LOAD'
            
        return status
        
    def _get_state_string(self):
        states = {
            0: 'BATTERY',
            1: 'CHARGING',
            2: 'CHARGED',
            3: 'LOW_POWER',
            4: 'SHUTDOWN'
        }
        return states.get(self.current_data['state'], 'UNKNOWN')
        
    def _get_health_status(self):
        if self.current_data['state'] == 3:
            return 'LOW_POWER'
        elif self.current_data['state'] == 4:
            return 'SHUTDOWN'
        elif self.current_data['vbat'] > self.low_voltage:
            return 'NORMAL'
        else:
            return 'WARNING'
            
    def auto_land_if_needed(self):
        """Automatically initiate landing if conditions require it"""
        status = self.check_systems()
        
        if status['suggested_action'] == 'LAND_IMMEDIATELY' and not self.landing_initiated:
            print(f"CRITICAL BATTERY! {status['voltage']:.2f}V - Initiating emergency landing!")
            self._perform_emergency_landing()
            return True
            
        elif status['suggested_action'] == 'PREPARE_TO_LAND' and not self.landing_initiated:
            print(f"Low battery warning: {status['voltage']:.2f}V ({status['percentage']}%)")
            remaining_time = self.estimate_remaining_time()
            print(f"Estimated remaining flight time: {remaining_time:.1f}s")
            
            if remaining_time < 30: # 30 second buffer
                self._perform_controlled_landing()
                return True
                
        return False
        
    def estimate_remaining_time(self):
        """Estimate remaining flight time based on multiple factors"""
        if self.current_data['state'] in (1, 2): # Charging/charged
            return float('inf')
            
        # Simple estimation based on voltage drop rate
        current_power = self.current_data['vbat'] * abs(self.current_data['extCurr'])
        
        # Placeholder - would need historical data for accurate estimation
        # This is a simplified linear approximation
        if current_power > 0:
            return (self.current_data['vbat'] - self.critical_voltage) / current_power * 3600
        return 0
        
    def _perform_controlled_landing(self):
        """Perform a gradual controlled landing"""
        self.landing_initiated = True
        print("Starting controlled landing sequence...")
        
        # Gradually reduce altitude
        for height in [0.5, 0.3, 0.1]: # Example heights
            self.cf.commander.send_hover_setpoint(0, 0, 0, height)
            time.sleep(2)
            
        self.cf.commander.send_stop_setpoint()
        
    def _perform_emergency_landing(self):
        """Immediate landing procedure"""
        self.landing_initiated = True
        print("EMERGENCY LANDING!")
        self.cf.commander.send_stop_setpoint()
