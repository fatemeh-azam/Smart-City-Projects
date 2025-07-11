"""
BatteryMonitor Class

Author:
    Fatemeh Azam (faa5778@utulsa.edu)

Description:
    Monitors the battery status of a Crazyflie drone in real-time using its power
    management (PM) log data. The class evaluates battery health, provides warnings,
    and can automatically initiate a controlled or emergency landing when thresholds
    are breached.

Key Features:
    - Real-time battery voltage, current, and state monitoring
    - Automatic emergency landing on critical battery levels
    - Voltage logging and CSV export for offline analysis
    - Lookup table generation to estimate remaining flight time
"""


from cflib.crazyflie import Crazyflie
from cflib.crazyflie.log import LogConfig
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
import time

class BatteryMonitor:
    def __init__(self, cf):
         """
        Initialize the BatteryMonitor with a Crazyflie instance.

        Args:
        cf (Crazyflie): An instance of the Crazyflie API object.
        """
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
        """
        Handle incoming battery log data.

        Updates the internal battery state based on received telemetry values.
    
        Args:
            timestamp (float): Timestamp of the log data.
            data (dict): Logged key-value battery data.
            logconf (LogConfig): The associated log configuration.
        """
        
       
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
       

    def setup_logging(self):
         """
        Configure and start logging of battery-related parameters.

        Registers a logging configuration with variables such as voltage, current, and
        battery level. Binds the log callback to process incoming telemetry.
        """
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
        """
        Analyze current battery telemetry and return system status.

        Returns:
            dict: Contains battery voltage, charge %, power state, charging status,
                  overall health, and any recommended action (e.g., 'LAND_IMMEDIATELY').
        """

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
        """
        Convert numeric battery state to human-readable form.

        Returns:
            str: Power state description (e.g., 'CHARGING', 'BATTERY', etc.).
        """
        states = {
            0: 'BATTERY',
            1: 'CHARGING',
            2: 'CHARGED',
            3: 'LOW_POWER',
            4: 'SHUTDOWN'
        }
        return states.get(self.current_data['state'], 'UNKNOWN')
        
    def _get_health_status(self):
        """
        Determine battery health based on voltage and power state.

        Returns:
            str: Health status ('NORMAL', 'WARNING', 'LOW_POWER', or 'SHUTDOWN').
        """
        if self.current_data['state'] == 3:
            return 'LOW_POWER'
        elif self.current_data['state'] == 4:
            return 'SHUTDOWN'
        elif self.current_data['vbat'] > self.low_voltage:
            return 'NORMAL'
        else:
            return 'WARNING'
            
    def auto_land_if_needed(self):
        """
        Check battery status and initiate landing if needed.

        Triggers controlled or emergency landing depending on voltage thresholds.

        Returns:
            bool: True if a landing procedure was initiated, False otherwise.
        """
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
        
    def estimate_remaining_time(self, current_voltage):
         """
        Estimates the remaining flight time for the Crazyflie based on current voltage.

        This method uses a lookup table generated from real flight data. It first checks 
        for an exact match in the lookup; if none exists, it performs a nearest-neighbor 
        search to find the closest voltage bin and returns the associated average remaining 
        time.

        Args:
            current_voltage (float): The current battery voltage reading (in volts).

        Returns:
            float or None: Estimated remaining time in seconds, or None if the lookup 
            table hasn't been generated yet.
        """
        
        if not self._voltage_lookup:
            print("Lookup table is not generated yet.")
            return None

        # Try exact match first
        if current_voltage in self._voltage_lookup:
            return self._voltage_lookup[current_voltage]

        # If no exact match, find the nearest voltage
        nearest_voltage = min(self._voltage_nearest_lookup, key=lambda v: abs(v - current_voltage))
        estimated_time = self._voltage_lookup[nearest_voltage]

        print(f"Approximated: {current_voltage:.2f} V → {estimated_time:.2f} minutes remaining (nearest match: {nearest_voltage:.2f} V)")
        return estimated_time
        
    def _perform_controlled_landing(self):
        """
        Perform a gradual descent to land the drone safely.
        """
        self.landing_initiated = True
        print("Starting controlled landing sequence...")
        
        # Gradually reduce altitude
        for height in [0.5, 0.3, 0.1, 0.0]: # Example heights
            self.cf.commander.send_hover_setpoint(0, 0, 0, height)
            time.sleep(2)
            
        self.cf.commander.send_stop_setpoint()
        
    def _perform_emergency_landing(self):
        """
        Immediate landing procedure
        """
        self.landing_initiated = True
        print("EMERGENCY LANDING!")
        self.cf.commander.send_stop_setpoint()


    def record_voltage_intervals(self, filename="log.csv", duration_sec=360, interval_ms=1000):
         """
        Log battery voltage at fixed intervals and save data to a CSV file.

        Args:
            filename (str): Output CSV filename.
            duration_sec (int): Total duration to log data in seconds.
            interval_ms (int): Sampling interval in milliseconds.
        """
        print(f"Starting voltage logging for {duration_sec} seconds...")

        log_config = LogConfig(name='VoltageLogger', period_in_ms=interval_ms)
        log_config.add_variable('pm.vbat', 'float')

        # Prepare logging context
        self._voltage_log_context = {
            'start_time': time.time(),
            'end_time': time.time() + duration_sec,
            'filename': filename,
            'data_log': [],
            'log_config': log_config
        }

        log_config.data_received_cb.add_callback(self._voltage_interval_log_callback)
        self.cf.log.add_config(log_config)
        log_config.start()

    def _voltage_interval_log_callback(self, timestamp, data, logconf):
        """
        Callback for periodic voltage logging.

        Collects and stores voltage data at regular intervals for later analysis.
        Automatically triggers lookup table generation when complete.
        """
        context = self._voltage_log_context
        if not context:
            return  # No active logging session

        current_time = time.time()
        elapsed_time = current_time - context['start_time']
        voltage = data.get('pm.vbat', 0.0)

        context['data_log'].append((elapsed_time, voltage))
        print(f"{elapsed_time:.2f}s: {voltage:.2f} V")

        if current_time >= context['end_time']:
            try:
                self.cf.log.remove_config(context['log_config'])
            except Exception:
                pass  # Logging already stopped or removed

            with open(context['filename'], "w", newline='') as csvfile:
                writer = csv.writer(csvfile)
                writer.writerow(['Elapsed Time (s)', 'Voltage (V)'])
                writer.writerows(context['data_log'])

            print(f"Battery voltage log saved to {context['filename']}")
            self._voltage_log_context = None  # clear context

            # Call the lookup generation
            self.generate_voltage_lookup_table(context['filename'])
    
    


    def generate_voltage_lookup_table(self, filename="log.csv"):
        """
        Generate a voltage-to-time lookup table from recorded log data.

        Args:
            filename (str): Path to the CSV file with voltage log data.

        Generates:
            - Internal voltage lookup dictionary
            - Nearest-neighbor voltage bin list
            - External CSV file: 'voltage_lookup_table.csv'
        """
        try:
            df = pd.read_csv(filename)

            if 'Elapsed Time (s)' not in df.columns or 'Voltage (V)' not in df.columns:
                print("Required columns not found in the CSV.")
                return

            df.rename(columns={'Elapsed Time (s)': 'Time (s)'}, inplace=True)

            df["Voltage_bin"] = df["Voltage (V)"].round(2)
            df["Remaining Time (sec)"] = (df["Time (s)"].max() - df["Time (s)"]) 

            voltage_lookup = df.groupby("Voltage_bin")["Remaining Time (sec)"].mean().to_dict()

            print("\nVoltage to Remaining Time Lookup Table:")
            for v, t in sorted(voltage_lookup.items(), reverse=True):
                print(f"{v:.2f} V → {t:.2f} sec remaining")

            # Nearest-neighbor lookup function
            def nearest_lookup(voltage):
                if not voltage_lookup:
                    return None
                closest = min(voltage_lookup.keys(), key=lambda v: abs(v - voltage))
                return voltage_lookup[closest]

            # Save it for external use
            self._voltage_lookup = voltage_lookup
            self._voltage_nearest_lookup = sorted(voltage_lookup.keys()) 
            # Save lookup table to CSV
            lookup_df = pd.DataFrame(list(voltage_lookup.items()), columns=["Voltage_bin", "Avg Remaining Time (sec)"])
            lookup_df.to_csv("voltage_lookup_table.csv", index=False)
            print('Lookup table saved to "voltage_lookup_table.csv"')

        except Exception as e:
            print(f"Error generating lookup table: {e}")
