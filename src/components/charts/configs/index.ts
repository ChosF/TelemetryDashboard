/**
 * Chart Configurations Index
 * Re-exports all chart configuration factories
 */

// Speed charts
export {
    createSpeedChartOptions,
    createSpeedAccelChartOptions,
} from './speed';

// Power charts
export {
    createPowerChartOptions,
    createVoltageStabilityOptions,
    createCurrentPeaksOptions,
    createEnergyCumulativeOptions,
} from './power';

// IMU charts
export {
    createIMUAccelChartOptions,
    createIMUGyroChartOptions,
    createIMUDetailChartOptions,
    createIMUOrientationChartOptions,
    createIMUVibrationChartOptions,
} from './imu';

// Efficiency charts
export {
    createEfficiencyChartOptions,
    createEfficiencyTrendOptions,
} from './efficiency';

// Altitude/GPS charts
export {
    createAltitudeChartOptions,
    createGPSSpeedChartOptions,
} from './altitude';
