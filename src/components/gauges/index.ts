/**
 * Gauges Component Index
 * Re-exports all gauge components
 */

// Base gauge
export { CanvasGauge } from './CanvasGauge';
export type { CanvasGaugeProps } from './CanvasGauge';

// Specialized gauges
export { SpeedGauge } from './SpeedGauge';
export type { SpeedGaugeProps } from './SpeedGauge';

export { BatteryGauge } from './BatteryGauge';
export type { BatteryGaugeProps } from './BatteryGauge';

export { PowerGauge } from './PowerGauge';
export type { PowerGaugeProps } from './PowerGauge';

export { EfficiencyGauge } from './EfficiencyGauge';
export type { EfficiencyGaugeProps } from './EfficiencyGauge';

// G-Force visualization is in charts
export { GForceScatter } from '../charts/GForceScatter';
export type { GForceScatterProps } from '../charts/GForceScatter';
