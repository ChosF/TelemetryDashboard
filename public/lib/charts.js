/**
 * Chart Management Layer for uPlot
 * Handles lazy initialization, visibility tracking, and unified update API
 */

const ChartManager = (function () {
    'use strict';

    // Chart registry
    const charts = {};
    const chartConfigs = {};

    // Theme colors matching current design
    const COLORS = {
        speed: '#1f77b4',
        voltage: '#22c55e',
        current: '#ef4444',
        power: '#f59e0b',
        gyroX: '#e74c3c',
        gyroY: '#2ecc71',
        gyroZ: '#3498db',
        accelX: '#f39c12',
        accelY: '#9b59b6',
        accelZ: '#34495e',
        pitch: '#ff6b6b',
        roll: '#4ecdc4',
        altitude: '#00d4ff',
        grid: 'rgba(255,255,255,0.1)',
        axis: 'rgba(255,255,255,0.5)',
        text: '#ffffff'
    };

    // Common uPlot options factory
    function baseOpts(title, width, height) {
        return {
            title: title,
            width: width,
            height: height,
            tzDate: ts => new Date(ts * 1000), // Convert seconds to milliseconds for Date constructor
            cursor: {
                sync: { key: 'telemetry' },
                drag: { x: true, y: true }
            },
            scales: {
                x: { time: true }
            },
            axes: [
                {
                    stroke: COLORS.axis,
                    grid: { stroke: COLORS.grid },
                    ticks: { stroke: COLORS.grid }
                },
                {
                    stroke: COLORS.axis,
                    grid: { stroke: COLORS.grid },
                    ticks: { stroke: COLORS.grid }
                }
            ],
            legend: { show: true }
        };
    }

    // LTTB downsampling for large datasets
    function lttbDownsample(data, threshold) {
        if (!data || data.length <= threshold) return data;

        const [timestamps, ...series] = data;
        const n = timestamps.length;

        if (n <= threshold) return data;

        const sampledIndices = [0];
        const bucketSize = (n - 2) / (threshold - 2);

        let a = 0;
        for (let i = 0; i < threshold - 2; i++) {
            const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
            const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

            // Average of next bucket
            let avgX = 0, avgY = 0, count = 0;
            for (let j = rangeStart; j < rangeEnd; j++) {
                avgX += timestamps[j];
                avgY += series[0][j] ?? 0;
                count++;
            }
            avgX /= count;
            avgY /= count;

            // Find point with max triangle area
            let maxArea = -1, maxIdx = rangeStart;
            for (let j = rangeStart; j < rangeEnd; j++) {
                const area = Math.abs(
                    (timestamps[a] - avgX) * ((series[0][j] ?? 0) - (series[0][a] ?? 0)) -
                    (timestamps[a] - timestamps[j]) * (avgY - (series[0][a] ?? 0))
                ) * 0.5;
                if (area > maxArea) {
                    maxArea = area;
                    maxIdx = j;
                }
            }

            sampledIndices.push(maxIdx);
            a = maxIdx;
        }
        sampledIndices.push(n - 1);

        // Build result
        const result = [sampledIndices.map(i => timestamps[i])];
        for (const s of series) {
            result.push(sampledIndices.map(i => s[i]));
        }
        return result;
    }

    // Convert telemetry rows to uPlot data format
    function rowsToUPlotData(rows, fields) {
        if (!rows || rows.length === 0) return [[]];

        const timestamps = rows.map(r => new Date(r.timestamp).getTime() / 1000);
        const data = [timestamps];

        for (const field of fields) {
            data.push(rows.map(r => {
                const v = r[field];
                return v === null || v === undefined ? null : Number(v);
            }));
        }

        return data;
    }

    // Create or get chart instance
    function getOrCreate(name, container, config) {
        if (charts[name]) return charts[name];

        const el = typeof container === 'string' ? document.getElementById(container) : container;
        if (!el) {
            console.warn(`ChartManager: Container "${container}" not found`);
            return null;
        }

        // Get container dimensions, use defaults if zero (hidden panel)
        let rect = el.getBoundingClientRect();
        let width = rect.width || 800;
        let height = rect.height || 400;

        // Clear any existing content
        el.innerHTML = '';

        const opts = { ...config, width: width, height: height };
        delete opts.data; // Remove data from options, pass separately

        const initialData = config.data || [[], []];
        const chart = new uPlot(opts, initialData, el);

        charts[name] = chart;
        chartConfigs[name] = config;

        console.log(`ChartManager: Created "${name}" chart (${width}x${height})`);

        return chart;
    }

    // Resize handler
    function handleResize(name) {
        const chart = charts[name];
        if (!chart) return;

        const el = chart.root.parentElement;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            chart.setSize({ width: rect.width, height: rect.height });
        }
    }

    // Public API
    return {
        COLORS,
        lttbDownsample,
        rowsToUPlotData,

        // Create Speed chart
        createSpeedChart(container, rows = []) {
            const data = rowsToUPlotData(rows, ['speed_ms']);
            const opts = {
                ...baseOpts('🚗 Vehicle Speed Over Time', 800, 300),
                series: [
                    {},
                    {
                        label: 'Speed (m/s)',
                        stroke: COLORS.speed,
                        width: 2,
                        fill: 'rgba(31, 119, 180, 0.1)'
                    }
                ],
                data
            };
            return getOrCreate('speed', container, opts);
        },

        // Create Power chart (Voltage & Current)
        createPowerChart(container, rows = []) {
            const data = rowsToUPlotData(rows, ['voltage_v', 'current_a']);
            const opts = {
                ...baseOpts('⚡ Electrical System', 800, 400),
                scales: {
                    x: { time: true },
                    y: {},
                    y2: {}
                },
                axes: [
                    { stroke: COLORS.axis, grid: { stroke: COLORS.grid } },
                    { stroke: COLORS.voltage, scale: 'y', label: 'Voltage (V)' },
                    {
                        stroke: COLORS.current,
                        scale: 'y2',
                        side: 1,
                        label: 'Current (A)',
                        grid: { show: false }
                    }
                ],
                series: [
                    {},
                    { label: 'Voltage', stroke: COLORS.voltage, width: 2, scale: 'y' },
                    { label: 'Current', stroke: COLORS.current, width: 2, scale: 'y2' }
                ],
                data
            };
            return getOrCreate('power', container, opts);
        },

        // Create IMU chart
        createIMUChart(container, rows = []) {
            const data = rowsToUPlotData(rows, ['gyro_x', 'gyro_y', 'gyro_z', 'accel_x', 'accel_y', 'accel_z']);
            const opts = {
                ...baseOpts('🧭 IMU Sensors', 800, 400),
                series: [
                    {},
                    { label: 'Gyro X', stroke: COLORS.gyroX, width: 1.5 },
                    { label: 'Gyro Y', stroke: COLORS.gyroY, width: 1.5 },
                    { label: 'Gyro Z', stroke: COLORS.gyroZ, width: 1.5 },
                    { label: 'Accel X', stroke: COLORS.accelX, width: 1.5 },
                    { label: 'Accel Y', stroke: COLORS.accelY, width: 1.5 },
                    { label: 'Accel Z', stroke: COLORS.accelZ, width: 1.5 }
                ],
                data
            };
            return getOrCreate('imu', container, opts);
        },

        // Create Altitude chart
        createAltitudeChart(container, rows = []) {
            const data = rowsToUPlotData(rows, ['altitude']);
            const opts = {
                ...baseOpts('🏔️ Altitude', 400, 200),
                series: [
                    {},
                    { label: 'Altitude (m)', stroke: COLORS.altitude, width: 2, fill: 'rgba(0, 212, 255, 0.1)' }
                ],
                data
            };
            return getOrCreate('altitude', container, opts);
        },

        // Create Efficiency scatter plot
        createEfficiencyChart(container, rows = []) {
            const data = [
                rows.map(r => r.speed_ms ?? 0),
                rows.map(r => r.power_w ?? 0)
            ];
            const opts = {
                ...baseOpts('📈 Efficiency: Speed vs Power', 800, 400),
                scales: { x: { time: false } },
                axes: [
                    { stroke: COLORS.axis, label: 'Speed (m/s)', grid: { stroke: COLORS.grid } },
                    { stroke: COLORS.axis, label: 'Power (W)', grid: { stroke: COLORS.grid } }
                ],
                series: [
                    { label: 'Speed' },
                    {
                        label: 'Power',
                        stroke: COLORS.power,
                        paths: () => null, // scatter plot
                        points: { show: true, size: 4, fill: COLORS.power }
                    }
                ],
                data
            };
            return getOrCreate('efficiency', container, opts);
        },

        // Update chart with new data
        updateChart(name, rows, maxPoints = 2000) {
            const chart = charts[name];
            if (!chart) return;

            let fields;
            switch (name) {
                case 'speed': fields = ['speed_ms']; break;
                case 'power': fields = ['voltage_v', 'current_a']; break;
                case 'imu': fields = ['gyro_x', 'gyro_y', 'gyro_z', 'accel_x', 'accel_y', 'accel_z']; break;
                case 'altitude': fields = ['altitude']; break;
                case 'efficiency':
                    const data = [
                        rows.map(r => r.speed_ms ?? 0),
                        rows.map(r => r.power_w ?? 0)
                    ];
                    chart.setData(data);
                    return;
                default: return;
            }

            let data = rowsToUPlotData(rows, fields);
            if (data[0].length > maxPoints) {
                data = lttbDownsample(data, maxPoints);
            }
            chart.setData(data);
        },

        // Resize all charts
        resizeAll() {
            for (const name in charts) {
                handleResize(name);
            }
        },

        // Setup global resize handler with debounce
        setupResizeHandler(debounceMs = 150) {
            let timeout;
            const resizeHandler = () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    this.resizeAll();
                }, debounceMs);
            };
            window.addEventListener('resize', resizeHandler, { passive: true });
            console.log('ChartManager: Resize handler installed');
        },

        // Create custom chart (line, scatter, or bar) with enhanced features
        createCustomChart(id, container, config, rows = []) {
            const el = typeof container === 'string' ? document.getElementById(container) : container;
            if (!el) return null;

            // Clear container and set up
            el.innerHTML = '';
            let rect = el.getBoundingClientRect();
            let width = rect.width || 600;
            let height = rect.height || 300;

            // Build data based on x/y fields (support multiple Y fields)
            const xField = config.x || 'timestamp';
            const yFields = Array.isArray(config.y) ? config.y : [config.y || 'speed_ms'];
            const isTimeX = xField === 'timestamp';
            const colors = config.colors || [COLORS.speed, COLORS.voltage, COLORS.current, COLORS.power];

            // Build data arrays
            let data;
            if (isTimeX) {
                data = [rows.map(r => new Date(r.timestamp).getTime() / 1000)];
            } else {
                data = [rows.map(r => Number(r[xField]) || 0)];
            }

            // Add each Y series
            yFields.forEach(yField => {
                data.push(rows.map(r => {
                    const v = r[yField];
                    return v === null || v === undefined ? null : Number(v);
                }));
            });

            const chartType = config.type || 'line';

            // Build series configs for each Y field
            const series = [{}];
            yFields.forEach((yField, i) => {
                const color = colors[i % colors.length];
                const seriesConfig = {
                    label: yField,
                    stroke: color,
                    width: 2
                };

                if (chartType === 'scatter') {
                    seriesConfig.paths = () => null;
                    seriesConfig.points = { show: true, size: 4, fill: color };
                }

                if (chartType === 'bar' || chartType === 'area') {
                    seriesConfig.fill = this.hexToRgba(color, 0.2);
                }

                series.push(seriesConfig);
            });

            const opts = {
                title: config.title || 'Custom Chart',
                width: width,
                height: height,
                tzDate: isTimeX ? (ts => new Date(ts * 1000)) : undefined, // Convert seconds to milliseconds for Date constructor
                scales: {
                    x: { time: isTimeX }
                },
                axes: [
                    { stroke: COLORS.axis, grid: { stroke: COLORS.grid } },
                    { stroke: COLORS.axis, grid: { stroke: COLORS.grid }, label: yFields.join(' / ') }
                ],
                series: series,
                legend: { show: config.showLegend !== false },
                cursor: {
                    sync: { key: 'custom' },
                    drag: { x: true, y: true }
                }
            };

            const chart = new uPlot(opts, data, el);
            charts[id] = chart;
            chartConfigs[id] = config;

            // Calculate and store stats if enabled
            if (config.showStats !== false && yFields.length === 1) {
                const values = data[1].filter(v => v !== null && !isNaN(v));
                if (values.length > 0) {
                    config.stats = {
                        min: Math.min(...values),
                        max: Math.max(...values),
                        avg: values.reduce((a, b) => a + b, 0) / values.length,
                        count: values.length
                    };
                }
            }

            return chart;
        },

        // Helper to convert hex to rgba
        hexToRgba(hex, alpha) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        },

        // Get stats for a custom chart
        getCustomChartStats(id) {
            return chartConfigs[id]?.stats || null;
        },

        // Update custom chart
        updateCustomChart(id, rows, config) {
            const chart = charts[id];
            if (!chart) return;

            const xField = config.x || 'timestamp';
            const yField = config.y || 'speed_ms';
            const isTimeX = xField === 'timestamp';

            let data;
            if (isTimeX) {
                data = [
                    rows.map(r => new Date(r.timestamp).getTime() / 1000),
                    rows.map(r => Number(r[yField]) || null)
                ];
            } else {
                data = [
                    rows.map(r => Number(r[xField]) || 0),
                    rows.map(r => Number(r[yField]) || null)
                ];
            }

            chart.setData(data);
        },

        // Destroy chart
        destroy(name) {
            if (charts[name]) {
                charts[name].destroy();
                delete charts[name];
                delete chartConfigs[name];
            }
        },

        // Get chart instance
        get(name) {
            return charts[name];
        },

        // Check if chart exists
        has(name) {
            return !!charts[name];
        }
    };
})();

window.ChartManager = ChartManager;
