/* historical-engine.js — Stats, Charts & Analysis Engine */
const __global = (typeof window !== 'undefined') ? window : self;
__global.HA = __global.HA || {};
(function (HA) {
    'use strict';
    // ── Stats ──
    HA.mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    HA.median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    HA.stddev = a => { const m = HA.mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1)); };
    HA.percentile = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (p / 100) * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
    HA.skewness = a => { const m = HA.mean(a), s = HA.stddev(a); if (s === 0) return 0; return a.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0) / a.length; };
    HA.kurtosis = a => { const m = HA.mean(a), s = HA.stddev(a); if (s === 0) return 0; return a.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0) / a.length - 3; };
    HA.pearson = (x, y) => { const n = Math.min(x.length, y.length); if (n < 3) return 0; const mx = HA.mean(x.slice(0, n)), my = HA.mean(y.slice(0, n)); let num = 0, dx2 = 0, dy2 = 0; for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy } const d = Math.sqrt(dx2 * dy2); return d ? num / d : 0; };
    // Regression
    HA.linReg = (x, y) => {
        const rx = HA.sma(x, 1), ry = HA.sma(y, 1);
        if (rx.length < 2) return { m: 0, b: 0, r2: 0 };
        const mX = HA.mean(rx), mY = HA.mean(ry);
        let num = 0, den = 0;
        for (let i = 0; i < rx.length; i++) {
            const dx = rx[i] - mX;
            num += dx * (ry[i] - mY); den += dx * dx;
        }
        const m = den === 0 ? 0 : num / den;
        const b = mY - m * mX;
        let ssTot = 0, ssRes = 0;
        for (let i = 0; i < ry.length; i++) {
            const f = m * rx[i] + b;
            ssTot += Math.pow(ry[i] - mY, 2);
            ssRes += Math.pow(ry[i] - f, 2);
        }
        return { m, b, r2: ssTot === 0 ? 0 : 1 - (ssRes / ssTot) };
    };

    // ── Physics Digital Twin / Simulation Models ──
    HA.physics = {
        mass_kg: 180,
        c_rr: 0.003,
        c_d: 0.12,
        a_m2: 0.5,
        rho_kgm3: 1.225,
        g: 9.81,

        calcRollingResistance: function (slopeRad = 0) {
            return this.c_rr * this.mass_kg * this.g * Math.cos(slopeRad);
        },
        calcSlopeResistance: function (slopeRad) {
            return this.mass_kg * this.g * Math.sin(slopeRad);
        },
        calcAeroResistance: function (velocityMs) {
            return 0.5 * this.rho_kgm3 * this.c_d * this.a_m2 * Math.pow(velocityMs, 2);
        },
        calcAccelerationResistance: function (accelMs2) {
            return this.mass_kg * accelMs2;
        },
        calcTotalForce: function (velocityMs, accelMs2, slopeRad = 0) {
            return this.calcRollingResistance(slopeRad) + this.calcSlopeResistance(slopeRad) +
                this.calcAeroResistance(velocityMs) + this.calcAccelerationResistance(accelMs2);
        },
        calcMechanicalPowerW: function (velocityMs, accelMs2, slopeRad = 0) {
            return this.calcTotalForce(velocityMs, accelMs2, slopeRad) * velocityMs;
        }
    };

    // ── AI & Pathfinding Models ──
    HA.ai = {
        /**
         * Generic A* (A-Star) Optimizer
         * @param {Object} startNode The starting state node.
         * @param {Function} isGoalFn Returns true if the node is the destination.
         * @param {Function} getNeighborsFn Returns an array of neighboring node states.
         * @param {Function} getCostFn Returns the weight/cost to travel from node A to B.
         * @param {Function} heuristicFn Returns estimated remaining cost to the goal (Dijkstra if returns 0).
         * @returns {Array|null} Array of states representing the optimal path, or null if unreachable.
         */
        aStar: function (startNode, isGoalFn, getNeighborsFn, getCostFn, heuristicFn) {
            // Priority queue simple array implementation (can optimize to min-heap later if needed)
            const openSet = [startNode];
            const cameFrom = new Map();

            const gScore = new Map();
            gScore.set(startNode, 0);

            const fScore = new Map();
            fScore.set(startNode, heuristicFn(startNode));

            while (openSet.length > 0) {
                // Find node in openSet with lowest fScore
                let currentIdx = 0;
                let currentF = fScore.get(openSet[0]) || Infinity;
                for (let i = 1; i < openSet.length; i++) {
                    const f = fScore.get(openSet[i]) || Infinity;
                    if (f < currentF) {
                        currentF = f;
                        currentIdx = i;
                    }
                }
                const current = openSet.splice(currentIdx, 1)[0];

                if (isGoalFn(current)) {
                    // Reconstruct path
                    const path = [current];
                    let currKey = current;
                    while (cameFrom.has(currKey)) {
                        currKey = cameFrom.get(currKey);
                        path.unshift(currKey);
                    }
                    return path;
                }

                const neighbors = getNeighborsFn(current);
                for (const neighbor of neighbors) {
                    const tentative_gScore = (gScore.get(current) || Infinity) + getCostFn(current, neighbor);
                    const n_gScore = gScore.get(neighbor) || Infinity;

                    if (tentative_gScore < n_gScore) {
                        cameFrom.set(neighbor, current);
                        gScore.set(neighbor, tentative_gScore);
                        fScore.set(neighbor, tentative_gScore + heuristicFn(neighbor));
                        if (!openSet.includes(neighbor)) {
                            openSet.push(neighbor);
                        }
                    }
                }
            }
            return null; // Unreachable
        },

        // --- EXPERIMENTAL DEEP LEARNING --- //

        /**
         * Real Multi-Layer Perceptron (Deep Neural Net Regressor)
         * Trains using Gradient Descent (Backpropagation).
         * Useful for predicting telemetry (e.g. Power as a function of Speed, Throttle, Slope).
         */
        trainNeuralNet: function (X, y, epochs = 100, learningRate = 0.01, hiddenNodes = 8) {
            const numSamples = X.length;
            if (numSamples === 0) return () => 0;
            const numFeatures = X[0].length;

            // Normalize inputs & outputs
            let xMins = Array(numFeatures).fill(Infinity), xMaxs = Array(numFeatures).fill(-Infinity);
            let yMin = Infinity, yMax = -Infinity;
            for (let i = 0; i < numSamples; i++) {
                if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i];
                for (let j = 0; j < numFeatures; j++) {
                    if (X[i][j] < xMins[j]) xMins[j] = X[i][j];
                    if (X[i][j] > xMaxs[j]) xMaxs[j] = X[i][j];
                }
            }
            const normX = [], normY = [];
            for (let i = 0; i < numSamples; i++) {
                let nx = [];
                for (let j = 0; j < numFeatures; j++) nx.push(xMaxs[j] === xMins[j] ? 0 : (X[i][j] - xMins[j]) / (xMaxs[j] - xMins[j]));
                normX.push(nx);
                normY.push(yMax === yMin ? 0 : (y[i] - yMin) / (yMax - yMin));
            }

            // Init weights
            let W1 = Array(numFeatures).fill().map(() => Array(hiddenNodes).fill().map(() => Math.random() * 2 - 1));
            let B1 = Array(hiddenNodes).fill().map(() => Math.random() * 2 - 1);
            let W2 = Array(hiddenNodes).fill().map(() => Math.random() * 2 - 1);
            let B2 = Math.random() * 2 - 1;

            const sigmoid = x => 1 / (1 + Math.exp(-x));
            const dSigmoid = y => y * (1 - y);

            // Train loop (heavy processing)
            for (let ep = 0; ep < epochs; ep++) {
                // Mini-batch stochastic
                for (let iter = 0; iter < Math.min(500, numSamples); iter++) {
                    let i = Math.floor(Math.random() * numSamples);
                    let input = normX[i];
                    let target = normY[i];

                    // Forward pass
                    let hidden = Array(hiddenNodes).fill(0);
                    for (let j = 0; j < hiddenNodes; j++) {
                        let sum = B1[j];
                        for (let k = 0; k < numFeatures; k++) sum += input[k] * W1[k][j];
                        hidden[j] = sigmoid(sum);
                    }

                    let outSum = B2;
                    for (let j = 0; j < hiddenNodes; j++) outSum += hidden[j] * W2[j];
                    let output = sigmoid(outSum);

                    // Backward pass
                    let error = target - output;
                    let dOut = error * dSigmoid(output);

                    let dHidden = Array(hiddenNodes).fill(0);
                    for (let j = 0; j < hiddenNodes; j++) {
                        dHidden[j] = dOut * W2[j] * dSigmoid(hidden[j]);
                        W2[j] += learningRate * dOut * hidden[j];
                    }
                    B2 += learningRate * dOut;

                    for (let k = 0; k < numFeatures; k++) {
                        for (let j = 0; j < hiddenNodes; j++) {
                            W1[k][j] += learningRate * dHidden[j] * input[k];
                        }
                    }
                    for (let j = 0; j < hiddenNodes; j++) B1[j] += learningRate * dHidden[j];
                }
            }

            return function predict(xRaw) {
                let nx = [];
                for (let j = 0; j < numFeatures; j++) nx.push(xMaxs[j] === xMins[j] ? 0 : (xRaw[j] - xMins[j]) / (xMaxs[j] - xMins[j]));

                let hidden = Array(hiddenNodes).fill(0);
                for (let j = 0; j < hiddenNodes; j++) {
                    let sum = B1[j];
                    for (let k = 0; k < numFeatures; k++) sum += nx[k] * W1[k][j];
                    hidden[j] = sigmoid(sum);
                }
                let outSum = B2;
                for (let j = 0; j < hiddenNodes; j++) outSum += hidden[j] * W2[j];
                let outNorm = sigmoid(outSum);
                return outNorm * (yMax - yMin) + yMin;
            };
        },

        /**
         * Random Forest Ensemble Regressor
         * Builds multiple decision trees on random subsets of data (Bagging).
         * Highly robust to overfitting and excellent for non-linear telemetry prediction.
         */
        trainRandomForest: function (X, y, numTrees = 10, maxDepth = 5) {
            const numSamples = X.length;
            if (numSamples === 0) return () => 0;
            const numFeatures = X[0].length;

            function buildTree(dataX, dataY, depth) {
                if (depth >= maxDepth || dataY.length <= 1) return { val: HA.mean(dataY) };

                let bestErr = Infinity, bestSplit = null;
                // Subsample features for Random Forest variance
                let feats = [];
                for (let i = 0; i < numFeatures; i++) if (Math.random() > 0.3) feats.push(i);
                if (feats.length === 0) feats.push(Math.floor(Math.random() * numFeatures));

                // Find best split
                for (let f of feats) {
                    let sorted = dataX.map((xRow, idx) => ({ x: xRow[f], y: dataY[idx] })).sort((a, b) => a.x - b.x);
                    // Test 10 percentiles to save time
                    for (let p = 1; p < 10; p++) {
                        let idx = Math.floor(sorted.length * (p / 10));
                        if (idx === 0 || idx >= sorted.length) continue;
                        let threshold = sorted[idx].x;

                        let lY = [], rY = [];
                        for (let i = 0; i < sorted.length; i++) {
                            if (sorted[i].x < threshold) lY.push(sorted[i].y);
                            else rY.push(sorted[i].y);
                        }

                        if (lY.length === 0 || rY.length === 0) continue;

                        let m1 = HA.mean(lY), m2 = HA.mean(rY);
                        let err = 0;
                        for (let v of lY) err += (v - m1) ** 2;
                        for (let v of rY) err += (v - m2) ** 2;

                        if (err < bestErr) {
                            bestErr = err;
                            let lX = [], lhY = [], rX = [], rhY = [];
                            for (let i = 0; i < dataX.length; i++) {
                                if (dataX[i][f] < threshold) { lX.push(dataX[i]); lhY.push(dataY[i]); }
                                else { rX.push(dataX[i]); rhY.push(dataY[i]); }
                            }
                            bestSplit = { feature: f, threshold, lX, lhY, rX, rhY };
                        }
                    }
                }

                if (!bestSplit) return { val: HA.mean(dataY) };

                return {
                    feature: bestSplit.feature,
                    threshold: bestSplit.threshold,
                    left: buildTree(bestSplit.lX, bestSplit.lhY, depth + 1),
                    right: buildTree(bestSplit.rX, bestSplit.rhY, depth + 1)
                };
            }

            let trees = [];
            for (let t = 0; t < numTrees; t++) {
                // Bootstrapping sample
                let bX = [], bY = [];
                for (let i = 0; i < Math.floor(numSamples * 0.6); i++) {
                    let idx = Math.floor(Math.random() * numSamples);
                    bX.push(X[idx]); bY.push(y[idx]);
                }
                trees.push(buildTree(bX, bY, 0));
            }

            return function predict(xRaw) {
                let sum = 0;
                for (let t of trees) {
                    let node = t;
                    while (node.left) {
                        if (xRaw[node.feature] < node.threshold) node = node.left;
                        else node = node.right;
                    }
                    sum += node.val;
                }
                return sum / trees.length;
            };
        },

        trainGBRegressor: function (X, y, numTrees = 10, maxDepth = 3, lr = 0.1) {
            const numSamples = X.length;
            if (numSamples === 0) return () => 0;
            const numFeatures = X[0].length;

            const meanY = HA.mean(y);
            let trees = [];

            function buildTree(dataX, dataY, depth) {
                if (depth >= maxDepth || dataY.length <= 1) return { val: HA.mean(dataY) };

                let bestErr = Infinity, bestSplit = null;
                let feats = [];
                for (let i = 0; i < numFeatures; i++) if (Math.random() > 0.3) feats.push(i);
                if (feats.length === 0) feats.push(Math.floor(Math.random() * numFeatures));

                for (let f of feats) {
                    let sorted = dataX.map((xRow, idx) => ({ x: xRow[f], y: dataY[idx] })).sort((a, b) => a.x - b.x);
                    for (let p = 1; p < 5; p++) {
                        let idx = Math.floor(sorted.length * (p / 5));
                        if (idx === 0 || idx >= sorted.length) continue;
                        let threshold = sorted[idx].x;

                        let lY = [], rY = [];
                        for (let i = 0; i < sorted.length; i++) {
                            if (sorted[i].x < threshold) lY.push(sorted[i].y);
                            else rY.push(sorted[i].y);
                        }

                        if (lY.length === 0 || rY.length === 0) continue;

                        let m1 = HA.mean(lY), m2 = HA.mean(rY);
                        let err = 0;
                        for (let v of lY) err += (v - m1) ** 2;
                        for (let v of rY) err += (v - m2) ** 2;

                        if (err < bestErr) {
                            bestErr = err;
                            let lX = [], lhY = [], rX = [], rhY = [];
                            for (let i = 0; i < dataX.length; i++) {
                                if (dataX[i][f] < threshold) { lX.push(dataX[i]); lhY.push(dataY[i]); }
                                else { rX.push(dataX[i]); rhY.push(dataY[i]); }
                            }
                            bestSplit = { feature: f, threshold, lX, lhY, rX, rhY };
                        }
                    }
                }

                if (!bestSplit) return { val: HA.mean(dataY) };

                return {
                    feature: bestSplit.feature,
                    threshold: bestSplit.threshold,
                    left: buildTree(bestSplit.lX, bestSplit.lhY, depth + 1),
                    right: buildTree(bestSplit.rX, bestSplit.rhY, depth + 1)
                };
            }

            let currentPreds = Array(numSamples).fill(meanY);
            for (let t = 0; t < numTrees; t++) {
                let residuals = [];
                for (let i = 0; i < numSamples; i++) residuals.push(y[i] - currentPreds[i]);

                let tree = buildTree(X, residuals, 0);
                trees.push(tree);

                for (let i = 0; i < numSamples; i++) {
                    let node = tree;
                    while (node.left) {
                        if (X[i][node.feature] < node.threshold) node = node.left;
                        else node = node.right;
                    }
                    currentPreds[i] += lr * node.val;
                }
            }

            return function predict(xRaw) {
                let sum = meanY;
                for (let t of trees) {
                    let node = t;
                    while (node.left) {
                        if (xRaw[node.feature] < node.threshold) node = node.left;
                        else node = node.right;
                    }
                    sum += lr * node.val;
                }
                return sum;
            };
        },

        trainPolyRegression: function (X, y, degree = 2, epochs = 200, lr = 0.05) {
            const numSamples = y.length;
            if (numSamples === 0) return () => 0;
            const numFeatures = X[0].length;

            let xMins = Array(numFeatures).fill(Infinity), xMaxs = Array(numFeatures).fill(-Infinity);
            let yMin = Infinity, yMax = -Infinity;
            for (let i = 0; i < numSamples; i++) {
                if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i];
                for (let j = 0; j < numFeatures; j++) {
                    if (X[i][j] < xMins[j]) xMins[j] = X[i][j];
                    if (X[i][j] > xMaxs[j]) xMaxs[j] = X[i][j];
                }
            }

            const normX = [], normY = [];
            for (let i = 0; i < numSamples; i++) {
                let nx = [];
                for (let j = 0; j < numFeatures; j++) nx.push(xMaxs[j] === xMins[j] ? 0 : (X[i][j] - xMins[j]) / (xMaxs[j] - xMins[j]));
                normX.push(nx);
                normY.push(yMax === yMin ? 0 : (y[i] - yMin) / (yMax - yMin));
            }

            let W = Array(numFeatures).fill().map(() => Array(degree).fill(0));
            let B = 0;

            for (let ep = 0; ep < epochs; ep++) {
                for (let i = 0; i < Math.min(300, numSamples); i++) {
                    let idx = Math.floor(Math.random() * numSamples);
                    let input = normX[idx];
                    let target = normY[idx];

                    let pred = B;
                    for (let f = 0; f < numFeatures; f++) {
                        for (let d = 1; d <= degree; d++) pred += W[f][d - 1] * Math.pow(input[f], d);
                    }

                    let err = target - pred;

                    B += lr * err;
                    for (let f = 0; f < numFeatures; f++) {
                        for (let d = 1; d <= degree; d++) {
                            W[f][d - 1] += lr * err * Math.pow(input[f], d);
                        }
                    }
                }
            }

            return function predict(xRaw) {
                let nx = [];
                for (let j = 0; j < numFeatures; j++) nx.push(xMaxs[j] === xMins[j] ? 0 : (xRaw[j] - xMins[j]) / (xMaxs[j] - xMins[j]));

                let pred = B;
                for (let f = 0; f < numFeatures; f++) {
                    for (let d = 1; d <= degree; d++) pred += W[f][d - 1] * Math.pow(nx[f], d);
                }
                let realVal = pred * (yMax - yMin) + yMin;
                return isNaN(realVal) ? 0 : realVal;
            };
        }
    };
    HA.sma = (a, w) => { if (!a || !a.length) return []; const res = []; for (let i = 0; i < a.length; i++) { let sum = 0, c = 0; for (let j = Math.max(0, i - w + 1); j <= i; j++) { sum += a[j]; c++; } res.push(sum / c); } return res; };
    HA.integral = (x, y) => { if (!x || !y || x.length !== y.length || x.length < 2) return 0; let sum = 0; for (let i = 1; i < x.length; i++) { const dx = x[i] - x[i - 1]; if (dx > 0) sum += (y[i] + y[i - 1]) / 2 * dx; } return sum; };

    // ── Format Helpers ──
    HA.fmt = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d);
    HA.fmtInt = v => v == null ? '—' : Number(v).toLocaleString();
    HA.fmtTime = ms => { if (ms == null || ms <= 0) return '—'; const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return m > 0 ? m + 'm ' + s + 's' : s + 's'; };
    HA.esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

    // ── Chart Theme ──
    HA.CHART_THEME = {
        backgroundColor: 'transparent',
        textStyle: { color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter' },
        grid: { left: 56, right: 16, top: 28, bottom: 36 },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(12,14,20,0.95)', borderColor: 'rgba(0,212,190,0.2)', textStyle: { color: '#e8eaef', fontSize: 12 } },
        xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { show: false }, axisLabel: { fontSize: 10, formatter: function (val) { const d = new Date(val); return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0') } } },
        yAxis: { type: 'value', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } }, axisLabel: { fontSize: 10 } },
    };

    // Standard dataZoom config for time-series charts
    HA.DATA_ZOOM = [
        { type: 'inside', xAxisIndex: [0] },
        { type: 'slider', xAxisIndex: [0], height: 20, bottom: 4, borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.02)', fillerColor: 'rgba(0,212,190,0.10)', handleStyle: { color: '#00d4be' }, textStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 9 } },
    ];

    HA.mkSeries = (name, data, color, areaOpacity = 0.15) => {
        // Parse color to build a proper rgba for the gradient stop
        let topColor = color;
        if (areaOpacity) {
            // If hex, convert to rgba
            if (color.startsWith('#')) {
                const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
                topColor = `rgba(${r},${g},${b},${areaOpacity})`;
            } else if (color.startsWith('rgba')) {
                // Replace last number (alpha) in rgba(...)
                topColor = color.replace(/,[\d.]+\)$/, `,${areaOpacity})`);
            } else if (color.startsWith('rgb(')) {
                topColor = color.replace('rgb(', 'rgba(').replace(')', `,${areaOpacity})`);
            }
        }
        return {
            name, type: 'line', data, smooth: false, showSymbol: false, sampling: 'lttb',
            lineStyle: { color, width: 1.5 }, itemStyle: { color },
            areaStyle: areaOpacity ? { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: topColor }, { offset: 1, color: 'rgba(0,0,0,0)' }] } } : undefined,
        };
    };

    HA.PIE_COLORS = ['#00d4be', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#6366f1'];

    // ── Chart Management ──
    HA.charts = {};
    HA.initChart = (id, opts) => {
        const el = document.getElementById(id);
        if (!el) return null;
        if (HA.charts[id]) { try { HA.charts[id].dispose() } catch (e) { } }
        const c = echarts.init(el);
        c.setOption(opts);
        HA.charts[id] = c;
        const ro = new ResizeObserver(() => { try { c.resize() } catch (e) { } });
        ro.observe(el);
        return c;
    };
    HA.disposeCharts = () => {
        Object.values(HA.charts).forEach(c => { try { c.dispose() } catch (e) { } });
        HA.charts = {};
    };

    // ── Normalize Record ──
    HA.normalizeRecord = r => {
        const n = { ...r };
        n._ts = new Date(r.timestamp).getTime();
        n.speed_kmh = r.speed_ms != null ? r.speed_ms * 3.6 : (r.speed_kmh || r.avg_speed_kmh || 0);
        n.speed_ms = r.speed_ms != null ? r.speed_ms : n.speed_kmh / 3.6;
        n.power_w = r.power_w != null ? r.power_w : ((r.voltage_v || 0) * (r.current_a || 0));
        n.voltage_v = r.voltage_v || 0; n.current_a = r.current_a || 0;
        n.throttle_pct = r.throttle_pct || r.throttle || 0;
        n.brake_pct = r.brake_pct || r.brake || 0;
        n.brake2_pct = r.brake2_pct || (typeof r.brake2 === 'number' ? r.brake2 * 100 : 0);
        n.motor_voltage_v = r.motor_voltage_v || 0;
        n.motor_current_a = r.motor_current_a || 0;
        n.motor_rpm = r.motor_rpm || 0;
        n.motor_phase_current_a = r.motor_phase_current_a || 0;
        n.throttle_intensity = r.throttle_intensity || null;
        n.brake_intensity = r.brake_intensity || null;
        n.accel_x = r.accel_x || 0; n.accel_y = r.accel_y || 0; n.accel_z = r.accel_z || 0;
        n.g_force = r.current_g_force || (Math.sqrt(n.accel_x ** 2 + n.accel_y ** 2 + n.accel_z ** 2) / 9.81);
        n.max_g_force = r.max_g_force || n.g_force;
        n.accel_magnitude = r.accel_magnitude || r.total_acceleration || 0;
        n.lat = r.latitude || 0; n.lon = r.longitude || 0; n.alt = r.altitude_m || 0;
        n.elevation_gain_m = r.elevation_gain_m || 0;
        n.efficiency = r.current_efficiency_km_kwh ?? null;
        n.cumEnergy = r.cumulative_energy_kwh ?? null;
        n.routeDist = r.route_distance_km ?? null;
        n.energy_j = r.energy_j || 0; n.distance_m = r.distance_m || 0;
        n.avg_speed_kmh = r.avg_speed_kmh || 0; n.max_speed_kmh = r.max_speed_kmh || 0;
        n.avg_power = r.avg_power || 0; n.avg_voltage = r.avg_voltage || 0; n.avg_current = r.avg_current || 0;
        n.max_power_w = r.max_power_w || 0; n.max_current_a = r.max_current_a || 0;
        n.optimalSpeed = r.optimal_speed_kmh ?? null;
        n.optimalEfficiency = r.optimal_efficiency_km_kwh ?? null;
        n.optimalConfidence = r.optimal_speed_confidence ?? null;
        n.motionState = r.motion_state || null; n.driverMode = r.driver_mode || null;
        n.qualityScore = r.quality_score ?? null;
        // Outlier data: backend stores nested object { severity, flagged_fields, ... } OR flat outlier_severity
        const outliersObj = r.outliers && typeof r.outliers === 'object' ? r.outliers : null;
        n.outlierSeverity = r.outlier_severity || outliersObj?.severity || null;
        // Normalise 'none' → null so filters work cleanly
        if (n.outlierSeverity === 'none' || n.outlierSeverity === '') n.outlierSeverity = null;
        // Flagged fields: may be array on nested object, or comma-string on flat field
        n.outlierFields = outliersObj?.flagged_fields || outliersObj?.fields ||
            (r.outlier_fields ? (typeof r.outlier_fields === 'string' ? r.outlier_fields.split(',') : r.outlier_fields) : null);
        // Legacy fallback: r.outliers as string/array of field names (old format)
        if (!n.outlierFields && r.outliers && typeof r.outliers === 'string') n.outlierFields = r.outliers.split(',');
        if (!n.outlierFields && Array.isArray(r.outliers)) n.outlierFields = r.outliers;
        // Detection reasons: object keyed by field name → reason code
        n.outlierReasons = outliersObj?.reasons || outliersObj?.confidence ? outliersObj.reasons : null;
        return n;
    };

    // ── Compute Session Stats (for compare) ──
    HA.computeSessionStats = data => {
        const speeds = data.map(r => r.speed_kmh).filter(v => v > 0);
        let distMeters = 0;
        let integratedEnergyWh = 0;
        for (let i = 1; i < data.length; i++) {
            const dt = (data[i]._ts - data[i - 1]._ts) / 1000;
            if (dt > 0 && dt < 60) distMeters += data[i].speed_ms * dt;
            const dtH = dt / 3600;
            if (dtH > 0 && dtH < 0.02) integratedEnergyWh += Math.abs(data[i].power_w) * dtH;
        }
        const last = data[data.length - 1] || null;
        const serverDistanceKm = last && Number.isFinite(last.routeDist) && last.routeDist > 0
            ? last.routeDist
            : null;
        const serverEnergyWh = last && Number.isFinite(last.cumEnergy) && last.cumEnergy > 0
            ? last.cumEnergy * 1000
            : null;
        const distKm = serverDistanceKm ?? (distMeters / 1000);
        const energyWh = serverEnergyWh ?? integratedEnergyWh;
        const durationMs = data.length > 1 ? data[data.length - 1]._ts - data[0]._ts : 0;
        const backendEfficiency = last && Number.isFinite(last.efficiency) && last.efficiency > 0 && last.efficiency < 1000
            ? last.efficiency
            : null;
        const computedEfficiency = energyWh > 0 ? distKm / (energyWh / 1000) : 0;
        return {
            distance: distKm, maxSpeed: speeds.length ? Math.max(...speeds) : 0, avgSpeed: HA.mean(speeds),
            energyWh, efficiency: backendEfficiency ?? computedEfficiency, durationMin: durationMs / 60000,
            avgPower: HA.mean(data.map(r => r.power_w)), maxG: data.length ? Math.max(...data.map(r => r.g_force)) : 0,
            optimalSpeed: data.find(r => r.optimalSpeed != null)?.optimalSpeed || 0,
            qualityScore: (() => { const q = data.map(r => r.qualityScore).filter(v => v != null); return q.length ? q.reduce((a, b) => a + b, 0) / q.length : 0 })(),
            elevationGain: data.length ? Math.max(...data.map(r => r.elevation_gain_m)) : 0,
            anomalyCount: data.filter(r => r.outlierSeverity != null).length,
            recordCount: data.length,
        };
    };


    // ── STAT_FIELDS ──
    HA.STAT_FIELDS = [
        { key: 'speed_kmh', label: 'Speed (km/h)' },
        { key: 'power_w', label: 'Power (W)' },
        { key: 'voltage_v', label: 'Voltage (V)' },
        { key: 'current_a', label: 'Current (A)' },
        { key: 'motor_voltage_v', label: 'Motor Voltage (V)' },
        { key: 'motor_current_a', label: 'Motor Current (A)' },
        { key: 'motor_rpm', label: 'Motor RPM' },
        { key: 'motor_phase_current_a', label: 'Phase Current (A)' },
        { key: 'throttle_pct', label: 'Throttle (%)' },
        { key: 'brake_pct', label: 'Brake (%)' },
        { key: 'brake2_pct', label: 'Brake 2 (%)' },
        { key: 'accel_x', label: 'Accel X' },
        { key: 'accel_y', label: 'Accel Y' },
        { key: 'accel_z', label: 'Accel Z' },
        { key: 'g_force', label: 'G-Force' },
        { key: 'alt', label: 'Altitude (m)' },

        // Extended Database Variables
        { key: 'efficiency', label: 'Efficiency (km/kWh)' },
        { key: 'cumEnergy', label: 'Cumulative Energy (kWh)' },
        { key: 'routeDist', label: 'Distance Covered (km)' },
        { key: 'optimalSpeed', label: 'Optimal Speed (km/h)' },
        { key: 'optimalEfficiency', label: 'Optimal Efficiency (km/kWh)' },

        // Server Health & Diagnostics
        { key: 'qualityScore', label: 'Server Quality Score (Health)' },
        { key: 'outlierSeverity', label: 'Outlier Severity' },
        { key: 'throttle_intensity', label: 'Throttle Intensity' },
        { key: 'brake_intensity', label: 'Brake Intensity' }
    ];

})(__global.HA);
