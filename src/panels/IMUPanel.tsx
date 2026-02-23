/**
 * IMUPanel - Inertial measurement unit analysis
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { UPlotChart, createIMUAccelChartOptions, createIMUGyroChartOptions, createIMUOrientationChartOptions, createIMUVibrationChartOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface IMUPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

/**
 * IMU analysis panel
 */
export function IMUPanel(props: IMUPanelProps): JSX.Element {
    // Accelerometer data
    const accelData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], [], []];

        const timestamps: number[] = [];
        const ax: (number | null)[] = [];
        const ay: (number | null)[] = [];
        const az: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            ax.push(row.accel_x ?? null);
            ay.push(row.accel_y ?? null);
            az.push(row.accel_z ?? null);
        });

        return [timestamps, ax, ay, az];
    });

    // Gyroscope data
    const gyroData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], [], []];

        const timestamps: number[] = [];
        const gx: (number | null)[] = [];
        const gy: (number | null)[] = [];
        const gz: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            gx.push(row.gyro_x ?? null);
            gy.push(row.gyro_y ?? null);
            gz.push(row.gyro_z ?? null);
        });

        return [timestamps, gx, gy, gz];
    });

    // Orientation data
    const orientationData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], [], []];

        const timestamps: number[] = [];
        const roll: (number | null)[] = [];
        const pitch: (number | null)[] = [];
        const gTotal: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            roll.push(row.roll_deg ?? null);
            pitch.push(row.pitch_deg ?? null);
            gTotal.push(row.g_total ?? null);
        });

        return [timestamps, roll, pitch, gTotal];
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Accelerometer */}
            <Panel title="Accelerometer (X, Y, Z)" loading={props.loading}>
                <div style={{ height: '280px' }}>
                    <UPlotChart
                        options={createIMUAccelChartOptions()}
                        data={accelData()}
                    />
                </div>
            </Panel>

            {/* Gyroscope */}
            <Panel title="Gyroscope (X, Y, Z)" loading={props.loading}>
                <div style={{ height: '280px' }}>
                    <UPlotChart
                        options={createIMUGyroChartOptions()}
                        data={gyroData()}
                    />
                </div>
            </Panel>

            {/* Orientation */}
            <PanelGrid columns={2} gap={16}>
                <Panel title="Orientation (Roll/Pitch)" loading={props.loading}>
                    <div style={{ height: '220px' }}>
                        <UPlotChart
                            options={createIMUOrientationChartOptions()}
                            data={orientationData()}
                        />
                    </div>
                </Panel>

                <Panel title="Vibration Intensity" loading={props.loading}>
                    <div style={{ height: '220px' }}>
                        <UPlotChart
                            options={createIMUVibrationChartOptions()}
                            data={[orientationData()[0], props.data.map((r) => r.total_acceleration ?? null)]}
                        />
                    </div>
                </Panel>
            </PanelGrid>
        </div>
    );
}

export default IMUPanel;
