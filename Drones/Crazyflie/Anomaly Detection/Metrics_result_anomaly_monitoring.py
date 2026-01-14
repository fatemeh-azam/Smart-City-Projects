import matplotlib.pyplot as plt
import numpy as np
import json
import time
import os
import glob
from datetime import datetime
from collections import deque
import matplotlib.gridspec as gridspec
from matplotlib.patches import Rectangle

class DroneMissionPlotter:
    def __init__(self, missions):
        self.missions = missions
        self.system_failure_metrics = {}  # uri -> {'first_failure': time, 'total_downtime': seconds}
        # Initialize ALL data structures FIRST
        self.drone_files = {}
        self.drone_positions = {}
        self.drone_paths = {}
        self.drone_colors = {}
        self.controller_history = {}
        self.anomaly_status = {}
        self.anomaly_start_time = {}
        
        # Message history for side panel
        self.message_history = deque(maxlen=50)
        self.message_display_count = 15
        self.current_page = 0
        
        # Data rate monitoring
        self.last_data_timestamps = {}
        self.data_rate_anomalies = {}
        self.no_data_alerts_sent = {}
        
        #Enhanced data rate monitoring
        self.last_data_timestamps = {}
        self.last_actual_data_timestamps = {}  # Track actual data timestamps
        self.data_rate_anomalies = {}
        self.no_data_alerts_sent = {}
        self.consecutive_missing_checks = 0
        self.last_warning_time = 0
        self.last_console_alert = 0  # Track last console alert time
        # NOW setup the plot with side panel
        self.setup_plot_with_messages()
        
        # CLEAN UP: Remove all previous log files for fresh start
        self.cleanup_previous_logs()
        
        self.setup_mission_layout()
    
    def setup_plot_with_messages(self):
        """Setup the main plot with side message panel"""
        # Create figure with two subplots: main plot and message panel
        self.fig = plt.figure(figsize=(18, 8))
        gs = gridspec.GridSpec(1, 2, width_ratios=[2, 1])
        
        # Main plot for drone tracking
        self.ax = plt.subplot(gs[0])
        
        # Message panel
        self.msg_ax = plt.subplot(gs[1])
        self.msg_ax.set_facecolor('#f8f9fa')
        self.msg_ax.set_xlim(0, 1)
        self.msg_ax.set_ylim(0, 1)
        self.msg_ax.axis('off')
        
        # Title for message panel
        self.msg_ax.text(0.5, 0.95, 'DRONE MISSION LOG', 
                        fontsize=14, weight='bold', ha='center',
                        bbox=dict(boxstyle="round,pad=0.5", facecolor='lightblue', alpha=0.8))
        
        # Setup keyboard listeners for scrolling
        self.fig.canvas.mpl_connect('key_press_event', self.on_key_press)
        
        # Initial message
        self.add_message("Mission plotter initialized", "SYSTEM")
        self.add_message("Use UP/DOWN keys to scroll messages", "SYSTEM")
        
        plt.tight_layout()
        plt.ion()
        plt.show(block=False)
        plt.pause(0.1)
    
    def on_key_press(self, event):
        """Handle keyboard events for scrolling messages"""
        total_pages = max(1, (len(self.message_history) + self.message_display_count - 1) // self.message_display_count)
        
        if event.key == 'up' or event.key == 'pageup':
            # Scroll to older messages
            self.current_page = min(self.current_page + 1, total_pages - 1)
            self.update_message_display()
        elif event.key == 'down' or event.key == 'pagedown':
            # Scroll to newer messages
            self.current_page = max(self.current_page - 1, 0)
            self.update_message_display()
        elif event.key == 'home':
            # Jump to latest messages
            self.current_page = 0
            self.update_message_display()
    
    def add_message(self, message, msg_type="INFO"):
        """Add a message to the message history and update display"""
        timestamp = datetime.now().strftime('%H:%M:%S')
        formatted_message = f"[{timestamp}] {message}"
        
        # Color coding based on message type
        if msg_type == "ANOMALY":
            color = 'red'
            prefix = "[ALERT] "
        elif msg_type == "RECOVERY":
            color = 'green'
            prefix = "[OK] "
        elif msg_type == "CONTROLLER":
            color = 'blue'
            prefix = "[CTRL] "
        elif msg_type == "SYSTEM":
            color = 'purple'
            prefix = "[SYS] "
        elif msg_type == "DATA_RATE":
            color = 'orange'
            prefix = "[DATA] "
        else:
            color = 'black'
            prefix = "[INFO] "
        
        full_message = f"{prefix}{formatted_message}"
        self.message_history.appendleft((full_message, color))
        
        # Update message display
        self.update_message_display()
    
    def update_message_display(self):
        """Update the message panel with current messages"""
        # Clear message area
        self.msg_ax.clear()
        self.msg_ax.set_facecolor('#f8f9fa')
        self.msg_ax.set_xlim(0, 1)
        self.msg_ax.set_ylim(0, 1)
        self.msg_ax.axis('off')
        
        # Title
        self.msg_ax.text(0.5, 0.97, 'REAL-TIME MISSION LOG', 
                        fontsize=14, weight='bold', ha='center', color='navy',
                        bbox=dict(boxstyle="round,pad=0.5", facecolor='lightblue', alpha=0.8))
        
        # Calculate page info
        total_pages = max(1, (len(self.message_history) + self.message_display_count - 1) // self.message_display_count)
        
        # Display messages for current page
        y_position = 0.90
        line_height = 0.055
        
        start_idx = self.current_page * self.message_display_count
        end_idx = start_idx + self.message_display_count
        
        messages_to_show = list(self.message_history)[start_idx:end_idx]
        
        for i, (message, color) in enumerate(messages_to_show):
            if y_position > 0.15:  # More space for page info
                # Add subtle background for readability
                self.msg_ax.add_patch(Rectangle((0.02, y_position - 0.025), 0.96, 0.05,
                                              facecolor='white', alpha=0.7, edgecolor='lightgray'))
                
                self.msg_ax.text(0.05, y_position, message, 
                               fontsize=8, color=color, ha='left', va='top',
                               wrap=True, fontfamily='monospace')
                y_position -= line_height
        
        # Page navigation info
        if total_pages > 1:
            page_info = f"Page {self.current_page + 1} of {total_pages}"
            instructions = "UP/DOWN: Scroll  HOME: Latest messages"
            
            self.msg_ax.text(0.5, 0.10, page_info,
                           fontsize=9, color='blue', ha='center', weight='bold',
                           bbox=dict(boxstyle="round,pad=0.3", facecolor='lightyellow', alpha=0.8))
            self.msg_ax.text(0.5, 0.06, instructions,
                           fontsize=7, color='gray', ha='center', style='italic')
        else:
            self.msg_ax.text(0.5, 0.08, "All messages fit - no scrolling needed",
                           fontsize=7, color='gray', ha='center', style='italic')
        
        plt.draw()
    
    def check_data_rate_anomaly(self, uri, current_time, has_new_data=True, data_timestamp=None):
        """Enhanced data rate monitoring with actual data age tracking and console logging"""
        # Initialize tracking for this drone if needed
        if uri not in self.last_data_timestamps:
            self.last_data_timestamps[uri] = current_time
            self.last_actual_data_timestamps[uri] = current_time
            self.data_rate_anomalies[uri] = False
            self.no_data_alerts_sent[uri] = False
            self.consecutive_missing_checks = 0
            self.last_warning_time = 0
            self.last_console_alert = 0
            return False, 0, "NORMAL"
    
        # Calculate time since last ACTUAL data (not just file read)
        if data_timestamp is not None:
            # Use the actual timestamp from the data itself
            time_since_actual_data = current_time - data_timestamp
            self.last_actual_data_timestamps[uri] = data_timestamp
        else:
            # Fall back to file read time
            time_since_actual_data = current_time - self.last_actual_data_timestamps.get(uri, current_time)
    
        # Update last check time
        if has_new_data:
            self.last_data_timestamps[uri] = current_time
    
        # Check data rate at different severity levels
        warning_threshold = 2.0  # 2 seconds for warning (yellow)
        alarm_threshold = 4.0    # 4 seconds for alarm (red)
        critical_threshold = 8.0 # 8 seconds for critical (flashing red)
    
        # Determine anomaly level based on ACTUAL data age
        if time_since_actual_data > critical_threshold:
            anomaly_level = "CRITICAL"
            data_rate_anomaly = True
        elif time_since_actual_data > alarm_threshold:
            anomaly_level = "ALARM" 
            data_rate_anomaly = True
        elif time_since_actual_data > warning_threshold:
            anomaly_level = "WARNING"
            data_rate_anomaly = True
        else:
            anomaly_level = "NORMAL"
            data_rate_anomaly = False
        # DETECT AND RECORD SYSTEM FAILURE (add this after your anomaly level checks)
        if anomaly_level == "CRITICAL":  # e.g., > 8 seconds without data
            if uri not in self.system_failure_metrics:
                # FIRST TIME we see critical failure for this drone
                self.system_failure_metrics[uri] = {
                    'first_failure_time': current_time,
                    'attack_start_time': current_time - time_since_actual_data,  # Approximate
                    'time_to_failure': time_since_actual_data,  # This is your key metric
                    'downtime_start': current_time
                }
                # Log this as a formal metric for your results table
                drone_num = list(self.missions.keys()).index(uri) + 1
                print(f"\n[EXPERIMENT_METRIC] Drone {drone_num} - SYSTEM FAILURE DETECTED")
                print(f"    Time from attack start to logging failure: {time_since_actual_data:.2f}s")
            
        elif anomaly_level == "NORMAL" and uri in self.system_failure_metrics:
            # SYSTEM RECOVERED - calculate total downtime
            downtime = current_time - self.system_failure_metrics[uri]['downtime_start']
            self.system_failure_metrics[uri]['total_downtime'] = downtime
            self.system_failure_metrics[uri]['recovery_time'] = current_time
        
            drone_num = list(self.missions.keys()).index(uri) + 1
            print(f"\n[EXPERIMENT_METRIC] Drone {drone_num} - LOGGING RECOVERED")
            print(f"    Total logging downtime: {downtime:.2f}s")
    
        # Track consecutive missing checks
        if not has_new_data:
            self.consecutive_missing_checks += 1
        else:
            self.consecutive_missing_checks = 0
    
        # Handle state changes and messaging
        drone_num = list(self.missions.keys()).index(uri) + 1
        current_state = self.data_rate_anomalies.get(uri, False)
    
        if data_rate_anomaly != current_state:
            # State changed
            if data_rate_anomaly:
                # New anomaly detected
                if anomaly_level == "WARNING":
                    message = f"⚠ WARNING: Drone {drone_num} data delay - last data {time_since_actual_data:.1f}s ago"
                    self.add_message(message, "DATA_RATE")
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                    self.last_warning_time = current_time
                    self.last_console_alert = current_time
                elif anomaly_level == "ALARM":
                    message = f" ALARM: Drone {drone_num} stopped sending data - last data {time_since_actual_data:.1f}s ago"
                    self.add_message(message, "ANOMALY")
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                    self.last_warning_time = current_time
                    self.last_console_alert = current_time
                elif anomaly_level == "CRITICAL":
                    message = f" CRITICAL: Drone {drone_num} DATA LOST - last data {time_since_actual_data:.1f}s ago"
                    self.add_message(message, "ANOMALY")
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                    self.last_warning_time = current_time
                    self.last_console_alert = current_time
            else:
                # Anomaly cleared
                message = f" RECOVERED: Drone {drone_num} resumed normal data transmission"
                self.add_message(message, "RECOVERY")
                print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                self.consecutive_missing_checks = 0
                self.last_console_alert = 0
    
        # Persistent alarm for ongoing issues
        elif data_rate_anomaly and current_state:
            # Ongoing anomaly - send periodic updates
            time_since_last_alert = current_time - self.last_console_alert
        
            if anomaly_level == "CRITICAL" and time_since_last_alert > 5.0:
                # Critical: repeat alarm every 5 seconds
                message = f" STILL CRITICAL: Drone {drone_num} - no data for {time_since_actual_data:.1f}s"
                self.add_message(message, "ANOMALY")
                print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                self.last_console_alert = current_time
            elif anomaly_level == "ALARM" and time_since_last_alert > 10.0:
                # Alarm: repeat every 10 seconds  
                message = f" STILL ALARM: Drone {drone_num} - no data for {time_since_actual_data:.1f}s"
                self.add_message(message, "ANOMALY")
                print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                self.last_console_alert = current_time
            elif anomaly_level == "WARNING" and self.consecutive_missing_checks >= 2 and time_since_last_alert > 15.0:
                # Warning becomes alarm after 2 consecutive checks
                message = f" ALARM: Drone {drone_num} persistent data delay - {time_since_actual_data:.1f}s"
                self.add_message(message, "ANOMALY")
                print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")  # Console log
                self.last_console_alert = current_time
    
        self.data_rate_anomalies[uri] = data_rate_anomaly
    
        return data_rate_anomaly, time_since_actual_data, anomaly_level
    
    def cleanup_previous_logs(self):
        """Delete all previous drone log files for a clean start"""
        self.add_message("Cleaning up previous log files...", "SYSTEM")
        
        log_files = glob.glob("drone_position_*.jsonl")
        deleted_count = 0
        
        for log_file in log_files:
            try:
                os.remove(log_file)
                deleted_count += 1
            except Exception as e:
                self.add_message(f"Could not delete {log_file}: {e}", "SYSTEM")
        
        if deleted_count == 0:
            self.add_message("No previous log files found", "SYSTEM")
        else:
            self.add_message(f"Removed {deleted_count} previous log file(s)", "SYSTEM")
    
    def setup_mission_layout(self):
        """Setup the mission layout using start positions from missions dictionary"""
        self.ax.clear()
        colors = ['green', 'blue', 'red', 'orange', 'purple', 'brown']
        
        for i, (uri, (start_point, delivery_points)) in enumerate(self.missions.items()):
            color = colors[i % len(colors)]
            self.drone_colors[uri] = color
            self.controller_history[uri] = []
            self.anomaly_status[uri] = False
            drone_name = f"Drone {i+1}"
            
            self.add_message(f"{drone_name} assigned color: {color.upper()}", "SYSTEM")
            
            # Plot start point FROM MISSIONS DICTIONARY
            start_x, start_y = start_point
            self.ax.plot(start_x, start_y, 'o', markersize=20, color=color,
                        label=f'{drone_name} Start', markeredgecolor='black', markeredgewidth=3)
            self.ax.text(start_x, start_y + 0.2, 'START',
                        fontsize=12, color=color, ha='center', weight='bold',
                        bbox=dict(boxstyle="round,pad=0.3", facecolor='white', alpha=0.8))
            
            # Plot delivery points FROM MISSIONS DICTIONARY
            for j, (dx, dy) in enumerate(delivery_points):
                self.ax.plot(dx, dy, 's', markersize=15, color=color,
                           markerfacecolor='none', markeredgewidth=3, markeredgecolor=color)
                self.ax.text(dx, dy + 0.2, f'Delivery {j+1}',
                           fontsize=10, color=color, ha='center', weight='bold',
                           bbox=dict(boxstyle="round,pad=0.3", facecolor='white', alpha=0.8))
            
            # Generate and plot expected path USING START POSITION FROM MISSIONS
            path = self.generate_grid_path(start_point, delivery_points)
            if path:
                path_x = [point[0] for point in path]
                path_y = [point[1] for point in path]
                self.ax.plot(path_x, path_y, '--', color=color, alpha=0.5, linewidth=2,
                           label=f'{drone_name} Expected Path')
                self.drone_paths[uri] = path
        
        # Set view based on mission coordinates
        self.ax.set_xlim(-2.0, 2.0)
        self.ax.set_ylim(-2.0, 3.0)
        self.ax.set_xlabel('X Coordinate (meters)', fontsize=12)
        self.ax.set_ylabel('Y Coordinate (meters)', fontsize=12)
        self.ax.set_title('Real-time Drone Mission Tracking\nWaiting for drone data...', fontsize=14, weight='bold')
        self.ax.grid(True, alpha=0.3)
        self.ax.legend(loc='upper right')
        
        # Initialize drone tracking from log files (will be created by drone code)
        for uri in self.missions.keys():
            self.drone_positions[uri] = []
            filename = self.find_drone_log_file(uri)
            if filename:
                self.drone_files[uri] = filename
                self.add_message(f"Tracking {uri}", "SYSTEM")
            else:
                filename = f"drone_position_{uri.replace('://', '_').replace('/', '_')}.jsonl"
                self.drone_files[uri] = filename
                self.add_message(f"Waiting for log file: {filename}", "SYSTEM")
        
        plt.draw()
        plt.pause(0.1)
    
    def generate_grid_path(self, start, waypoints):
        """Generate the expected grid path using start position from missions"""
        path = []
        height = 0.6
        streetX = start[0]  # Use the X coordinate from missions start point
        
        for target in waypoints:
            yaw = 0
            path.append((streetX, target[1], height, yaw))
            
            if streetX != target[0]:
                path.append((target[0], target[1], height, yaw))
                path.append((streetX, target[1], height, yaw))
        
        return path
    
    def find_drone_log_file(self, uri):
        """Find the log file for a drone URI"""
        parts = uri.split('/')
        drone_id = parts[-1]
    
        pattern = f"drone_position_*{drone_id}*.jsonl"
        files = glob.glob(pattern)
    
        if files:
            return files[0]
    
        return None

    def check_if_off_course(self, uri, x, y):
        """Check if drone is far from its expected current target point"""
        # ONLY check for drone 1 (radio://0/80/2M/E7E7E7E7E9)
        if uri != 'radio://0/80/2M/E7E7E7E7E9':
            return False, 0  # Skip anomaly detection for other drones
    
        if uri not in self.drone_paths:
            return False, 0
    
        expected_path = self.drone_paths[uri]
    
        if not expected_path:
            return False, 0
    
        # Track mission progress for this drone
        if not hasattr(self, 'drone_progress'):
            self.drone_progress = {}
    
        if uri not in self.drone_progress:
            self.drone_progress[uri] = {
                'current_target_index': 0,
                'last_position': None,
                'last_update_time': time.time()
            }
    
        progress = self.drone_progress[uri]
        current_target_index = progress['current_target_index']
    
        # Safety check - don't go beyond path length
        if current_target_index >= len(expected_path):
            return False, 0
    
        # Get the point the drone should be heading towards RIGHT NOW
        target_point = expected_path[current_target_index]
        target_x, target_y = target_point[0], target_point[1]
    
        # Calculate distance to the CURRENT expected target
        distance_to_target = np.sqrt((x - target_x)**2 + (y - target_y)**2)
    
        # Check if we've reached the current target (close enough to move to next)
        reached_target = distance_to_target < 0.3  # 0.3m tolerance for reaching a point
    
        if reached_target:
            # Move to next target point
            progress['current_target_index'] += 1
            self.add_message(f"Drone 1 reached target {current_target_index}, moving to next point", "CONTROLLER")
        
            # If there's a next point, check distance to that instead
            if progress['current_target_index'] < len(expected_path):
                next_target = expected_path[progress['current_target_index']]
                next_x, next_y = next_target[0], next_target[1]
                distance_to_target = np.sqrt((x - next_x)**2 + (y - next_y)**2)
            else:
                # Mission complete for this drone
                return False, 0
    
        # ANOMALY DETECTION: Check if far from current expected position
        # Use different thresholds based on mission phase
    
        if progress['current_target_index'] == 0:
            # Just starting - be more lenient
            off_course = distance_to_target > 1.0  # 1.0m tolerance at start
        elif progress['current_target_index'] >= len(expected_path) - 2:
            # Near end of mission - more lenient
            off_course = distance_to_target > 1.0  # 1.0m tolerance near end
        else:
            # Middle of mission - strict checking
            off_course = distance_to_target > 0.8  # 0.8m tolerance during mission
    
        # Additional check: sudden large movement detection
        if progress['last_position'] is not None:
            last_x, last_y = progress['last_position']
            movement_distance = np.sqrt((x - last_x)**2 + (y - last_y)**2)
            time_elapsed = time.time() - progress['last_update_time']
        
            # If drone moved too far too fast, it's suspicious
            if time_elapsed > 0:  # Avoid division by zero
                speed = movement_distance / time_elapsed
                if speed > 2.0:  # 2.0 m/s is unusually fast for grid movement
                    self.add_message(f"SUSPICIOUS: Drone 1 moving at {speed:.1f} m/s", "ANOMALY")
                    off_course = True
    
        # Update progress tracking
        progress['last_position'] = (x, y)
        progress['last_update_time'] = time.time()
    
        # Debug output for anomaly detection
        if off_course:
            self.add_message(f"ANOMALY: Drone 1 is {distance_to_target:.2f}m from expected point {progress['current_target_index']}", "ANOMALY")
    
        return off_course, distance_to_target
    
    def read_latest_positions(self):
        """Read the latest positions from all drone log files"""
        new_positions = {}
        current_time = time.time()
    
        for uri, filename in self.drone_files.items():
            if os.path.exists(filename):
                try:
                    # Track if we found new data for this drone
                    found_new_data = False
                    latest_data_timestamp = None
                
                    # Read the entire file and get the last valid position line
                    with open(filename, 'r') as f:
                        lines = f.readlines()
                
                    # Find the last position data line (skip header and event markers)
                    for line in reversed(lines):
                        line = line.strip()
                        if line and not line.startswith('#') and 'event' not in line:
                            try:
                                data = json.loads(line)
                                if 'x' in data and 'y' in data and 'z' in data:
                                    found_new_data = True
                                    data_timestamp = data.get('timestamp', current_time)
                                    latest_data_timestamp = data_timestamp
                                
                                    # Check data rate anomaly using ACTUAL data timestamp
                                    data_rate_anomaly, time_since_data, anomaly_level = self.check_data_rate_anomaly(
                                        uri, current_time, has_new_data=True, data_timestamp=data_timestamp)
                                
                                    new_positions[uri] = {
                                        'x': data['x'],
                                        'y': data['y'], 
                                        'z': data['z'],
                                        'timestamp': data_timestamp,
                                        'controller': data.get('controller', 'unknown'),
                                        'datetime': data.get('datetime', ''),
                                        'data_rate_anomaly': data_rate_anomaly,
                                        'time_since_data': time_since_data,
                                        'anomaly_level': anomaly_level,
                                        'data_age': current_time - data_timestamp  # How old this data point is
                                    }
                                    break
                            except json.JSONDecodeError:
                                continue
                
                    if not found_new_data:
                        # No new data found for this drone - check data rate
                        data_rate_anomaly, time_since_data, anomaly_level = self.check_data_rate_anomaly(
                            uri, current_time, has_new_data=False)
                    
                        # If we have previous data, mark it as stale
                        if uri in self.drone_positions and self.drone_positions[uri]:
                            last_pos = self.drone_positions[uri][-1]
                            new_positions[uri] = {
                                'x': last_pos[0], 'y': last_pos[1], 'z': 0,
                                'timestamp': current_time,
                                'controller': 'unknown',
                                'data_rate_anomaly': data_rate_anomaly,
                                'time_since_data': time_since_data,
                                'anomaly_level': anomaly_level,
                                'stale_data': True,  # Mark as stale data
                                'data_age': time_since_data
                            }
                        else:
                            # No data at all for this drone
                            message = f"❌ NO DATA: Drone {list(self.missions.keys()).index(uri) + 1} - no position data received yet"
                            self.add_message(message, "DATA_RATE")
                            print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")
            
                except Exception as e:
                    error_msg = f"Error reading {filename}: {e}"
                    self.add_message(error_msg, "SYSTEM")
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] {error_msg}")
    
        return new_positions
    
    def update_controller_history(self, uri, controller, is_anomaly=False, is_data_anomaly=False):
        """Update controller history and detect changes"""
        if uri not in self.controller_history:
            self.controller_history[uri] = []
        
        current_time = time.time()
        
        # Always add anomaly status changes immediately
        current_anomaly = is_anomaly or is_data_anomaly
        
        if current_anomaly != self.anomaly_status.get(uri, False):
            if current_anomaly:
                self.anomaly_start_time[uri] = current_time
                drone_num = list(self.missions.keys()).index(uri) + 1
                if is_data_anomaly:
                    self.add_message(f"DATA ANOMALY: Drone {drone_num} stopped sending position data", "DATA_RATE")
                else:
                    self.add_message(f"PATH ANOMALY: Drone {drone_num} is off-course!", "ANOMALY")
            else:
                anomaly_duration = current_time - self.anomaly_start_time.get(uri, current_time)
                drone_num = list(self.missions.keys()).index(uri) + 1
                self.add_message(f"ANOMALY CLEARED: Drone {drone_num} back to normal after {anomaly_duration:.1f}s", "RECOVERY")
            
            self.anomaly_status[uri] = current_anomaly
        
        # Only add if controller changed or it's been more than 5 seconds
        if (not self.controller_history[uri] or 
            self.controller_history[uri][-1]['controller'] != controller or
            self.controller_history[uri][-1]['anomaly'] != current_anomaly or
            current_time - self.controller_history[uri][-1]['timestamp'] > 5):
            
            self.controller_history[uri].append({
                'controller': controller,
                'anomaly': current_anomaly,
                'path_anomaly': is_anomaly,
                'data_anomaly': is_data_anomaly,
                'timestamp': current_time,
                'time_str': datetime.now().strftime('%H:%M:%S')
            })
            
            # Keep only last 10 changes
            if len(self.controller_history[uri]) > 10:
                self.controller_history[uri] = self.controller_history[uri][-10:]
            
            # Print status change to message panel
            drone_num = list(self.missions.keys()).index(uri) + 1
            status_parts = []
            if is_anomaly:
                status_parts.append("PATH_ISSUE")
            if is_data_anomaly:
                status_parts.append("DATA_ISSUE")
            status = " | ".join(status_parts) if status_parts else "NORMAL"
            self.add_message(f"Drone {drone_num}: {controller.upper()} | STATUS: {status}", "CONTROLLER")
    
    def update_plot(self):
        """Update the plot with latest positions from log files"""
        # Clear previous drone markers
        for artist in self.ax.collections[:]:
            if hasattr(artist, '_drone_marker'):
                artist.remove()
        
        # Read latest positions from files
        latest_positions = self.read_latest_positions()
        
        # Update plot for each drone
        active_drones = 0
        current_controllers = {}
        anomaly_drones = 0
        data_anomaly_drones = 0
        
        for uri, pos_data in latest_positions.items():
            if pos_data:
                active_drones += 1
                x, y, z = pos_data['x'], pos_data['y'], pos_data['z']
                controller = pos_data.get('controller', 'unknown')
                data_rate_anomaly = pos_data.get('data_rate_anomaly', False)
                current_controllers[uri] = controller
                
                # Check if drone is off-course (ONLY for drone 1)
                is_off_course, distance_from_path = self.check_if_off_course(uri, x, y)
                
                # Update controller history with both types of anomalies
                self.update_controller_history(uri, controller, is_off_course, data_rate_anomaly)
                
                if is_off_course:
                    anomaly_drones += 1
                if data_rate_anomaly:
                    data_anomaly_drones += 1
                
                # Use fixed color for this drone, but change marker for anomalies
                color = self.drone_colors.get(uri, 'black')
                # Determine marker style based on anomaly type and level
                anomaly_level = pos_data.get('anomaly_level', 'NORMAL')
                stale_data = pos_data.get('stale_data', False)

                if stale_data:
                    # Stale data (no new updates) - use faded marker
                    marker = 'o'
                    marker_color = 'gray'
                    marker_size = 40
                    marker_alpha = 0.5
                    anomaly_text = f'STALE DATA ({time_since_data:.1f}s)'
                elif is_off_course and data_rate_anomaly:
                    # Both path and data anomalies
                    if anomaly_level == "CRITICAL":
                        marker = '^'
                        marker_color = 'darkred'
                        marker_size = 140
                    elif anomaly_level == "ALARM":
                        marker = '^' 
                        marker_color = 'red'
                        marker_size = 120
                    else:  # WARNING
                        marker = '^'
                        marker_color = 'orange'
                        marker_size = 100
                    anomaly_text = f'OFF COURSE & {anomaly_level}'
                elif is_off_course:
                    # Path anomaly only
                    marker = 'X'
                    marker_color = 'red'
                    marker_size = 100
                    anomaly_text = 'OFF COURSE'
                elif data_rate_anomaly:
                    # Data anomaly only
                    if anomaly_level == "CRITICAL":
                        marker = 'D'
                        marker_color = 'darkred' 
                        marker_size = 120
                    elif anomaly_level == "ALARM":
                        marker = 'D'
                        marker_color = 'red'
                        marker_size = 100
                    else:  # WARNING
                        marker = 'D'
                        marker_color = 'orange'
                        marker_size = 80
                    anomaly_text = f'DATA {anomaly_level}'
                else:
                    # Normal
                    marker = 'o'
                    marker_color = color
                    marker_size = 50
                    anomaly_text = None
                
                # Plot the marker
                self.ax.scatter(x, y, c=marker_color, s=marker_size, marker=marker,
                              edgecolors='white', linewidth=1.5, alpha=0.9,
                              label='_nolegend_')
                
                # Add anomaly indicator text if needed
                #if anomaly_text:
                #    self.ax.text(x, y - 0.25, anomaly_text, 
                #               fontsize=8, color=marker_color, ha='center', weight='bold')
                
                # Store position for history
                if uri not in self.drone_positions:
                    self.drone_positions[uri] = []
                self.drone_positions[uri].append((x, y))
                
                # Keep only last 100 positions
                if len(self.drone_positions[uri]) > 100:
                    self.drone_positions[uri] = self.drone_positions[uri][-100:]
        
        # Update title with both types of anomalies
        status_text = f"Active: {active_drones} | Path Issues: {anomaly_drones} | Data Issues: {data_anomaly_drones}"
        title_color = 'red' if (anomaly_drones > 0 or data_anomaly_drones > 0) else 'black'
        self.ax.set_title(f'Real-time Drone Mission Tracking\n{status_text}', 
                         fontsize=14, weight='bold', color=title_color)
        
        # Update color legend
        if hasattr(self, 'color_legend'):
            self.color_legend.remove()
            
        legend_text = "DRONE COLORS:\n"
        for uri, color in self.drone_colors.items():
            drone_num = list(self.missions.keys()).index(uri) + 1
            legend_text += f"• {color.upper()} = Drone {drone_num}\n"
        
        legend_text += "\nANOMALY TYPES:\n"
        legend_text += "• RED X = Off-course\n"
        legend_text += "• ORANGE ◇ = No data\n"
        legend_text += "• PURPLE △ = Both issues"
        
        self.color_legend = self.ax.text(0.02, 0.98, legend_text,
            transform=self.ax.transAxes, fontsize=8, verticalalignment='top',
            bbox=dict(boxstyle="round,pad=0.5", facecolor='lightblue', alpha=0.8))
        
        plt.draw()
        plt.pause(0.01)
        
        return active_drones, current_controllers, anomaly_drones, data_anomaly_drones
    
    def run_realtime_plot(self, update_interval=0.5):
        """Run the real-time plotter"""
        self.add_message("Starting mission plotter with dual anomaly detection", "SYSTEM")
        self.add_message("Monitoring: Path deviations + Data rate issues", "SYSTEM")
        
        last_update = 0
        try:
            while True:
                current_time = time.time()
                if current_time - last_update >= update_interval:
                    active_count, controllers, path_anomalies, data_anomalies = self.update_plot()
                    last_update = current_time
                    
                    # Print status every 15 seconds to message panel
                    if int(current_time) % 15 == 0:
                        if controllers:
                            total_anomalies = path_anomalies + data_anomalies
                            if total_anomalies > 0:
                                self.add_message(f"Status: {active_count} active, {path_anomalies} path issues, {data_anomalies} data issues", "ANOMALY")
                            else:
                                self.add_message(f"Status: All {active_count} drones operating normally", "INFO")
                        else:
                            self.add_message("Waiting for drone data... (No active drones yet)", "INFO")
                
                time.sleep(0.1)
                
        except KeyboardInterrupt:
            self.add_message("Mission plotter stopped by user", "SYSTEM")
            
            # Print final history to message panel
            self.add_message("Final Mission History:", "SYSTEM")
            for uri, history in self.controller_history.items():
                if history:
                    drone_num = list(self.missions.keys()).index(uri) + 1
                    for event in history[-3:]:
                        status_parts = []
                        if event['path_anomaly']:
                            status_parts.append("PATH_ISSUE")
                        if event['data_anomaly']:
                            status_parts.append("DATA_ISSUE")
                        status = " | ".join(status_parts) if status_parts else "NORMAL"
                        self.add_message(f"Drone {drone_num}: {event['time_str']} - {event['controller'].upper()} | {status}", "INFO")
        
        except Exception as e:
            self.add_message(f"Plotter error: {e}", "SYSTEM")
        
        plt.ioff()
        plt.show()

# Mission definitions (must match your drone flight code)
missions = {
    'radio://0/80/2M/E7E7E7E7E9': (
        (0.4, -1.85),  # This start position is used for plotting
        [(0.85, -1.24), (0.85, -0.78), (0.85, 0.95)]  
    ),
    'radio://0/80/2M/E7E7E7E7E8': (
        (-0.5, -1.85),  # This start position is used for plotting
        [(-1.04, -0.93), (-1.04, 1.09)] 
    )
}

if __name__ == '__main__':
    # Create and run the plotter - it will clean up files and use missions start positions
    plotter = DroneMissionPlotter(missions)
    
    print(" Waiting for drone position data from log files...")
    print("   Make sure drone flight code is running!")
    print("   Use UP/DOWN keys to scroll messages in the side panel")
    time.sleep(2)
    
    # Start real-time plotting
    plotter.run_realtime_plot(update_interval=0.5)
