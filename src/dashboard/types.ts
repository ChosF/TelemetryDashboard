import type { Component } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';

export type SystemViewId =
    | 'pit-wall'
    | 'efficiency-strategy'
    | 'power-energy'
    | 'motor-can'
    | 'vehicle-health'
    | 'dynamics'
    | 'track'
    | 'driver-inputs'
    | 'data-integrity';

export type WidgetType =
    | 'vehicle-pulse'
    | 'core-trend'
    | 'track-progress'
    | 'attention'
    | 'load-energy'
    | 'session-kpis'
    | 'live-gauges'
    | 'speed-summary'
    | 'speed-trend'
    | 'acceleration-trend'
    | 'speed-distribution'
    | 'speed-ranges'
    | 'efficiency-summary'
    | 'speed-power-relationship'
    | 'efficiency-trend'
    | 'efficiency-by-speed'
    | 'optimal-speed'
    | 'power-summary'
    | 'voltage-current-trend'
    | 'voltage-stability'
    | 'current-peaks'
    | 'energy-trend'
    | 'current-spike-log'
    | 'motor-summary'
    | 'motor-rpm-speed'
    | 'motor-phase-current'
    | 'motor-voltage'
    | 'motor-envelope'
    | 'motor-statistics'
    | 'dynamics-summary'
    | 'imu-sensor-trend'
    | 'orientation'
    | 'vibration'
    | 'motion-classification'
    | 'imu-axis-readout'
    | 'gyroscope-detail'
    | 'acceleration-detail'
    | 'force-peaks'
    | 'angular-histogram'
    | 'gps-summary'
    | 'route-map'
    | 'altitude-profile'
    | 'route-speed-profile'
    | 'quality-overview'
    | 'bridge-health'
    | 'outlier-analysis'
    | 'integrity-kpis'
    | 'quality-trend'
    | 'field-availability'
    | 'raw-telemetry'
    // Persisted v1 layouts are expanded to the granular types above at load time.
    | 'speed-analysis'
    | 'efficiency-analysis'
    | 'power-analysis'
    | 'motor-analysis'
    | 'health-summary'
    | 'dynamics-analysis'
    | 'track-analysis'
    | 'driver-inputs'
    | 'data-integrity'
    | 'custom-chart';

export type WidgetSize = 'compact' | 'standard' | 'wide' | 'hero';
export type WidgetImportance = 'safety-critical' | 'recommended' | 'optional' | 'analysis-only';

export interface WidgetConfig {
    metric?: string;
    comparisonMetric?: string;
    timeWindow?: '30s' | '60s' | '5m' | '15m' | 'session';
    chartStyle?: 'line' | 'area' | 'scatter' | 'bar' | 'histogram';
    series?: string[];
}

export interface WidgetLayout {
    instanceId: string;
    widgetType: WidgetType;
    title?: string;
    column: number;
    row: number;
    width: number;
    height: number;
    pinned: boolean;
    config: WidgetConfig;
}

export interface DashboardViewDefinition {
    id: SystemViewId;
    label: string;
    shortLabel: string;
    description: string;
    widgets: WidgetLayout[];
}

export type EventSeverity = 'critical' | 'warning' | 'info' | 'success';
export type EventStatus = 'active' | 'recovered';

export interface OperationalEvent {
    key: string;
    severity: EventSeverity;
    status: EventStatus;
    title: string;
    explanation: string;
    evidence: string;
    recommendedAction: string;
    relevantView: SystemViewId;
    occurrenceCount: number;
    firstOccurrence: number;
    lastOccurrence: number;
    acknowledged: boolean;
}

export interface WidgetRenderProps {
    rows: TelemetryRow[];
    liveRows: TelemetryRow[];
    inspectionMode: boolean;
    eventList: OperationalEvent[];
    acknowledgeEvent: (key: string, acknowledged: boolean) => void;
    activateView: (view: SystemViewId) => void;
    title?: string;
    config: WidgetConfig;
}

export interface WidgetDefinition {
    type: WidgetType;
    displayName: string;
    description: string;
    categories: SystemViewId[];
    requiredFields: Array<keyof TelemetryRow>;
    optionalFields: Array<keyof TelemetryRow>;
    allowedSizes: WidgetSize[];
    defaultSize: WidgetSize;
    minimumViewportBehavior: 'stack' | 'disclose' | 'scroll';
    performanceCost: 'low' | 'medium' | 'high';
    importance: WidgetImportance;
    validateConfig: (config: WidgetConfig) => boolean;
    component: Component<WidgetRenderProps>;
    emptyState: string;
    partialState: string;
    staleState: string;
    catalogHidden?: boolean;
}

export interface PersistedDashboardView {
    _id: string;
    viewKey: string;
    name: string;
    kind: 'system-override' | 'custom';
    systemViewId?: string;
    position: number;
    revision: number;
}
