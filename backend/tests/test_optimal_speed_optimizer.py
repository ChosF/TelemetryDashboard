import math
import random
import time
import unittest

from backend.maindata import OptimalSpeedOptimizer, TelemetryCalculator


class OptimalSpeedOptimizerTests(unittest.TestCase):
    AUXILIARY_W = 80.0
    ROLLING_FORCE_N = 12.0
    AERO_POWER_COEFFICIENT = 0.08
    VEHICLE_MASS_KG = 105.0
    SAMPLE_INTERVAL = 0.2

    def _power_for(self, speed, acceleration=0.0, grade=0.0):
        return (
            self.AUXILIARY_W
            + self.ROLLING_FORCE_N * speed
            + self.AERO_POWER_COEFFICIENT * speed ** 3
            + self.VEHICLE_MASS_KG * speed * acceleration
            + self.VEHICLE_MASS_KG * 9.80665 * speed * grade
        )

    def _train_physical_model(self, sample_count=1800, update_interval=5):
        optimizer = OptimalSpeedOptimizer(
            sample_interval=self.SAMPLE_INTERVAL,
            update_interval=update_interval,
        )
        random_source = random.Random(42)
        previous_speed = None
        result = optimizer.optimize()

        for index in range(sample_count):
            phase = (index % 300) / 299.0
            rising = (index // 300) % 2 == 0
            speed = 3.0 + 11.0 * (phase if rising else 1.0 - phase)
            acceleration = (
                0.0
                if previous_speed is None
                else (speed - previous_speed) / self.SAMPLE_INTERVAL
            )
            grade = 0.02 * math.sin(index * 0.017)
            power = self._power_for(speed, acceleration, grade)
            power += random_source.gauss(0.0, 8.0)

            optimizer.add_sample(
                speed,
                power,
                timestamp=index * self.SAMPLE_INTERVAL,
                road_grade=grade,
                acceleration_ms2=acceleration,
            )
            result = optimizer.optimize()
            previous_speed = speed

        return optimizer, result

    def test_converges_on_known_physics_with_acceleration_and_grade(self):
        optimizer, result = self._train_physical_model()
        expected_speed_ms = (
            self.AUXILIARY_W / (2.0 * self.AERO_POWER_COEFFICIENT)
        ) ** (1.0 / 3.0)
        expected_power = self._power_for(expected_speed_ms)
        expected_efficiency = expected_speed_ms * 3600.0 / expected_power

        self.assertGreater(optimizer.count, 1000)
        self.assertGreater(optimizer.count, 320)
        self.assertIsNotNone(result["optimal_speed_ms"])
        self.assertAlmostEqual(
            result["optimal_speed_ms"], expected_speed_ms, delta=0.35
        )
        self.assertAlmostEqual(
            result["optimal_efficiency_km_kwh"], expected_efficiency, delta=3.0
        )
        self.assertGreaterEqual(result["optimal_speed_confidence"], 0.75)

    def test_rejects_braking_cornering_and_invalid_samples(self):
        optimizer = OptimalSpeedOptimizer()

        self.assertTrue(optimizer.add_sample(6.0, 250.0, timestamp=0.0))
        self.assertFalse(
            optimizer.add_sample(6.0, 250.0, timestamp=0.2, brake_pct=20.0)
        )
        self.assertFalse(
            optimizer.add_sample(6.0, 250.0, timestamp=0.4, g_lat=0.5)
        )
        self.assertFalse(
            optimizer.add_sample(6.0, 250.0, timestamp=0.6, gyro_z=30.0)
        )
        self.assertFalse(optimizer.add_sample(6.0, -10.0, timestamp=0.8))
        self.assertFalse(optimizer.add_sample(1.0, 250.0, timestamp=1.0))
        self.assertEqual(optimizer.count, 1)

    def test_stable_single_speed_produces_supported_empirical_target(self):
        optimizer = OptimalSpeedOptimizer(update_interval=1)
        for index in range(250):
            speed = 8.0
            optimizer.add_sample(
                speed,
                self._power_for(speed),
                timestamp=index * self.SAMPLE_INTERVAL,
            )

        result = optimizer.optimize()
        self.assertEqual(result["optimal_speed_data_points"], 250)
        self.assertAlmostEqual(result["optimal_speed_ms"], 8.0, delta=0.05)
        self.assertAlmostEqual(result["optimal_speed_kmh"], 28.8, delta=0.1)
        self.assertGreaterEqual(result["optimal_speed_confidence"], 0.5)
        self.assertLessEqual(result["optimal_speed_confidence"], 0.65)
        self.assertEqual(
            result["optimal_speed_range"],
            {
                "min_kmh": 28.8,
                "max_kmh": 29.7,
                "efficiency_km_kwh": round(
                    8.0 * 3600.0 / self._power_for(8.0), 2
                ),
            },
        )

    def test_short_single_speed_run_does_not_recommend(self):
        optimizer = OptimalSpeedOptimizer(update_interval=1)
        for index in range(25):
            optimizer.add_sample(
                8.0,
                self._power_for(8.0),
                timestamp=index * self.SAMPLE_INTERVAL,
            )

        result = optimizer.optimize()
        self.assertIsNone(result["optimal_speed_ms"])
        self.assertEqual(result["optimal_speed_confidence"], 0.0)

    def test_quantized_real_run_shape_produces_cruise_recommendation(self):
        optimizer = OptimalSpeedOptimizer(update_interval=5)
        result = optimizer.optimize()

        for index in range(1200):
            if index < 100:
                speed = round((2.0 + index * 0.04) * 20.0) / 20.0
            elif index < 1000:
                speed = 6.0 + (index % 6) * 0.04
            else:
                speed = round((6.2 - (index - 1000) * 0.021) * 20.0) / 20.0
                speed = max(2.0, speed)
            power = 114.0 + 9.0 * math.sin(index * 0.19)
            optimizer.add_sample(
                speed,
                power,
                timestamp=index * self.SAMPLE_INTERVAL,
                g_lat=0.0,
                gyro_z=0.0,
            )
            result = optimizer.optimize()

        self.assertGreater(result["optimal_speed_data_points"], 1000)
        self.assertIsNotNone(result["optimal_speed_ms"])
        self.assertGreaterEqual(result["optimal_speed_kmh"], 21.6)
        self.assertLessEqual(result["optimal_speed_kmh"], 22.5)
        self.assertAlmostEqual(result["optimal_efficiency_km_kwh"], 193.0, delta=10.0)
        self.assertGreaterEqual(result["optimal_speed_confidence"], 0.5)

    def test_poor_fit_cannot_be_overridden_by_large_sample_count(self):
        optimizer = OptimalSpeedOptimizer(update_interval=1)
        random_source = random.Random(7)
        result = optimizer.optimize()

        for index in range(1800):
            speed = 8.0 + 4.0 * math.sin(index * 0.01)
            unrelated_power = random_source.uniform(100.0, 900.0)
            optimizer.add_sample(
                speed,
                unrelated_power,
                timestamp=index * self.SAMPLE_INTERVAL,
            )
            result = optimizer.optimize()

        self.assertGreater(optimizer.count, optimizer.OPTIMAL_DATA_POINTS)
        self.assertLess(result["optimal_speed_confidence"], 0.3)
        self.assertIsNone(result["optimal_speed_ms"])

    def test_reset_clears_model_and_evidence(self):
        optimizer, result = self._train_physical_model(sample_count=900)
        self.assertIsNotNone(result["optimal_speed_ms"])

        optimizer.reset()
        result = optimizer.optimize()

        self.assertEqual(optimizer.count, 0)
        self.assertEqual(optimizer.accepted_seconds, 0.0)
        self.assertIsNone(result["optimal_speed_ms"])
        self.assertEqual(result["optimal_speed_confidence"], 0.0)

    def test_speed_bucket_range_is_reported_in_kmh(self):
        calculator = TelemetryCalculator(sample_interval=self.SAMPLE_INTERVAL)
        result = {}
        for index in range(12):
            result = calculator.calculate(
                {
                    "timestamp": index * self.SAMPLE_INTERVAL,
                    "speed_ms": 6.0,
                    "voltage_v": 24.0,
                    "current_a": 12.5,
                    "power_w": 300.0,
                }
            )

        self.assertEqual(
            result["optimal_speed_range"],
            {
                "min_kmh": 18.0,
                "max_kmh": 36.0,
                "efficiency_km_kwh": 72.0,
            },
        )

    def test_telemetry_calculator_preserves_optimal_speed_contract(self):
        calculator = TelemetryCalculator(sample_interval=self.SAMPLE_INTERVAL)
        random_source = random.Random(42)
        previous_speed = None
        result = {}

        for index in range(1800):
            phase = (index % 300) / 299.0
            rising = (index // 300) % 2 == 0
            speed = 3.0 + 11.0 * (phase if rising else 1.0 - phase)
            acceleration = (
                0.0
                if previous_speed is None
                else (speed - previous_speed) / self.SAMPLE_INTERVAL
            )
            grade = 0.02 * math.sin(index * 0.017)
            power = self._power_for(speed, acceleration, grade)
            power += random_source.gauss(0.0, 8.0)
            result = calculator.calculate(
                {
                    "timestamp": index * self.SAMPLE_INTERVAL,
                    "speed_ms": speed,
                    "voltage_v": 24.0,
                    "current_a": power / 24.0,
                    "power_w": power,
                    "road_grade": grade,
                    "accel_x": acceleration,
                    "accel_y": 0.0,
                    "accel_z": 9.81,
                    "brake_pct": 0.0,
                    "gyro_z": 0.0,
                }
            )
            previous_speed = speed

        self.assertAlmostEqual(result["optimal_speed_kmh"], 28.57, delta=1.3)
        self.assertAlmostEqual(
            result["optimal_efficiency_km_kwh"], 132.8, delta=3.0
        )
        self.assertGreaterEqual(result["optimal_speed_confidence"], 0.75)
        self.assertGreater(result["optimal_speed_data_points"], 1000)

    def test_processing_throughput_is_suitable_for_live_telemetry(self):
        optimizer = OptimalSpeedOptimizer(update_interval=5)
        previous_speed = None
        started = time.perf_counter()

        for index in range(10000):
            speed = 8.0 + 4.0 * math.sin(index * 0.01)
            acceleration = (
                0.0
                if previous_speed is None
                else (speed - previous_speed) / self.SAMPLE_INTERVAL
            )
            power = self._power_for(speed, acceleration)
            optimizer.add_sample(
                speed,
                power,
                timestamp=index * self.SAMPLE_INTERVAL,
                acceleration_ms2=acceleration,
            )
            optimizer.optimize()
            previous_speed = speed

        elapsed = time.perf_counter() - started
        self.assertGreater(optimizer.count, 9000)
        self.assertLess(elapsed, 5.0)


if __name__ == "__main__":
    unittest.main()
