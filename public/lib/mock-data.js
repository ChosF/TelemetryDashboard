/**
 * Mock Data Generator for Telemetry Dashboard
 * Generates realistic telemetry data for testing without API access
 */
class MockDataGenerator {
    constructor(options = {}) {
        this.interval = options.interval || 100; // 10 Hz default
        this.running = false;
        this.timer = null;
        this.messageId = 0;
        this.sessionId = 'mock-session-' + Date.now();
        this.startTime = Date.now();

        // Simulation state
        this.state = {
            speed: 0,
            distance: 0,
            energy: 0,
            voltage: 54,
            throttle: 0,
            brake: 0,
            lat: 29.7604,  // Houston (Shell Eco-marathon Americas)
            lon: -95.3698,
            altitude: 15
        };
    }

    start(callback) {
        if (this.running) return;
        this.running = true;
        this.timer = setInterval(() => {
            const dataPoint = this.generateDataPoint();
            callback(dataPoint);
        }, this.interval);
        console.log('🚗 Mock data streaming started at', 1000 / this.interval, 'Hz');
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.timer);
        this.timer = null;
        console.log('🛑 Mock data streaming stopped');
    }

    generateDataPoint() {
        const now = Date.now();
        const elapsed = (now - this.startTime) / 1000;

        // Simulate driving patterns
        const phase = Math.sin(elapsed / 30) * 0.5 + 0.5; // 0-1 cycle every 60s
        const accel = Math.sin(elapsed / 5) * 0.3;

        // Update throttle/brake based on phase
        if (phase > 0.6) {
            this.state.throttle = Math.min(100, this.state.throttle + 5);
            this.state.brake = 0;
        } else if (phase < 0.3) {
            this.state.throttle = 0;
            this.state.brake = Math.min(100, this.state.brake + 3);
        } else {
            this.state.throttle = Math.max(0, this.state.throttle - 2);
            this.state.brake = Math.max(0, this.state.brake - 2);
        }

        // Update speed based on throttle/brake
        const speedDelta = (this.state.throttle * 0.02 - this.state.brake * 0.03 - 0.01);
        this.state.speed = Math.max(0, Math.min(15, this.state.speed + speedDelta));

        // Update distance
        this.state.distance += this.state.speed * (this.interval / 1000);

        // Power consumption
        const current = this.state.throttle > 0 ?
            2 + this.state.throttle * 0.15 + Math.random() * 2 :
            0.5 + Math.random() * 0.5;
        const power = this.state.voltage * current;
        this.state.energy += power * (this.interval / 1000);

        // Battery drain
        this.state.voltage = Math.max(50, 58 - (elapsed / 3600) * 2 + Math.random() * 0.1);

        // GPS simulation (small movement)
        this.state.lat += (Math.random() - 0.5) * 0.00001;
        this.state.lon += (Math.random() - 0.5) * 0.00001;
        this.state.altitude += (Math.random() - 0.5) * 0.1;

        // IMU data
        const gyroBase = this.state.speed * 0.5;
        const accelBase = this.state.speed * 0.1;

        this.messageId++;

        return {
            timestamp: new Date(now).toISOString(),
            message_id: this.messageId,
            session_id: this.sessionId,
            uptime_seconds: elapsed,

            // Speed & Distance
            speed_ms: this.state.speed,
            distance_m: this.state.distance,

            // Power
            voltage_v: this.state.voltage,
            current_a: current,
            power_w: power,
            energy_j: this.state.energy,

            // Driver inputs
            throttle_percent: this.state.throttle,
            brake_percent: this.state.brake,

            // GPS
            latitude: this.state.lat,
            longitude: this.state.lon,
            altitude: this.state.altitude,
            gps_speed: this.state.speed * 3.6,

            // IMU - Gyroscope
            gyro_x: gyroBase * (Math.random() - 0.5) * 2,
            gyro_y: gyroBase * (Math.random() - 0.5) * 2,
            gyro_z: gyroBase * (Math.random() - 0.5) * 0.5,

            // IMU - Accelerometer  
            accel_x: accelBase + (Math.random() - 0.5) * 0.5,
            accel_y: (Math.random() - 0.5) * 0.3,
            accel_z: 9.8 + (Math.random() - 0.5) * 0.2,

            // Temperature
            motor_temp_c: 35 + this.state.speed * 2 + Math.random() * 5,
            battery_temp_c: 28 + current * 0.5 + Math.random() * 2
        };
    }

    // Generate batch of historical data
    generateBatch(count = 1000, startTime = null) {
        const data = [];
        const start = startTime || Date.now() - count * this.interval;
        const savedStartTime = this.startTime;
        this.startTime = start;

        for (let i = 0; i < count; i++) {
            const point = this.generateDataPoint();
            point.timestamp = new Date(start + i * this.interval).toISOString();
            data.push(point);
        }

        this.startTime = savedStartTime;
        return data;
    }
}

// Export for use
window.MockDataGenerator = MockDataGenerator;
