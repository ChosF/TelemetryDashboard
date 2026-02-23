/* workers/historical-worker.js */
importScripts('../historical-engine.js');

self.onmessage = function (e) {
    const { id, type, payload } = e.data;

    try {
        if (type === 'NORMALIZE_RECORDS') {
            const { records } = payload;

            // Heavy array mapping and parsing
            const normalized = records.map(self.HA.normalizeRecord).sort((a, b) => a._ts - b._ts);

            // Calculate statistical summary offline for UI rendering
            const stats = self.HA.computeSessionStats(normalized);

            self.postMessage({
                id,
                type: 'SUCCESS',
                payload: { normalized, stats }
            });
        }
        else if (type === 'PROCESS_LAB_MATH') {
            // If we push the Custom Analytics Lab logic to the worker
            const { opType, data, args, newKey } = payload;

            // Copy data over if we don't want to mutate the massive object array across threads
            // Or since postMessage clones it, it's fine.
            let resData = data;

            // e.g. Basic Math
            if (opType === 'math') {
                const { a, b, op } = args;
                for (let i = 0; i < resData.length; i++) {
                    const valA = resData[i][a], valB = resData[i][b];
                    if (valA != null && valB != null) {
                        let r = 0;
                        if (op === '+') r = valA + valB;
                        else if (op === '-') r = valA - valB;
                        else if (op === '*') r = valA * valB;
                        else if (op === '/') r = valB !== 0 ? valA / valB : 0;
                        else if (op === '^') r = Math.pow(valA, valB);
                        resData[i][newKey] = r;
                    }
                }
            } else if (opType === 'func') {
                const { a, op } = args;
                for (let i = 0; i < resData.length; i++) {
                    const val = resData[i][a];
                    if (val != null) {
                        let r = 0;
                        if (op === 'abs') r = Math.abs(val);
                        else if (op === 'sqrt') r = val >= 0 ? Math.sqrt(val) : 0;
                        else if (op === 'sq') r = val * val;
                        else if (op === 'log') r = val > 0 ? Math.log(val) : 0;
                        resData[i][newKey] = r;
                    }
                }
            } else if (opType === 'calculus') {
                const { a, op } = args;
                let cumulative = 0;
                for (let i = 0; i < resData.length; i++) {
                    const val = resData[i][a];
                    const time = resData[i]._ts;
                    if (val != null && time != null) {
                        if (op === 'deriv') {
                            if (i > 0 && resData[i - 1][a] != null && resData[i - 1]._ts != null) {
                                const dt = (time - resData[i - 1]._ts) / 1000;
                                const dv = val - resData[i - 1][a];
                                resData[i][newKey] = dt > 0 ? dv / dt : 0;
                            } else {
                                resData[i][newKey] = 0;
                            }
                        } else if (op === 'integ') {
                            if (i > 0 && resData[i - 1][a] != null && resData[i - 1]._ts != null) {
                                const dt = (time - resData[i - 1]._ts) / 1000;
                                cumulative += ((val + resData[i - 1][a]) / 2) * dt;
                            }
                            resData[i][newKey] = cumulative;
                        }
                    }
                }
            } else if (opType === 'smooth') {
                const { a, op, w } = args;
                const mapped = resData.map(r => r[a] != null ? r[a] : 0);
                let smoothed = [];
                if (op === 'sma') smoothed = self.HA.sma(mapped, w);

                for (let i = 0; i < resData.length; i++) {
                    if (resData[i][a] != null && smoothed[i] !== undefined) {
                        resData[i][newKey] = smoothed[i];
                    }
                }
            }
            // Web workers naturally help memory GC as well.

            self.postMessage({
                id,
                type: 'SUCCESS',
                payload: { processedData: resData }
            });
        }
        else if (type === 'PROCESS_ML_SIMULATION') {
            const { data, algoStr, filters, xKey, yKeys, highlights, smoothType, smoothWindow } = payload;

            let customFn = null;
            if (algoStr) {
                const code = algoStr.includes('return') ? algoStr : `return ${algoStr};`;
                customFn = new Function('r', code);
            }

            const xData = [];
            let ySeriesObj = null;
            let hlData = [];
            let validPoints = 0;

            for (let i = 0; i < data.length; i++) {
                const r = data[i];

                let filterPass = true;
                for (const f of filters) {
                    const rowVal = r[f.key];
                    if (rowVal == null) { filterPass = false; break; }
                    if (f.op === '>' && !(rowVal > f.val)) filterPass = false;
                    if (f.op === '<' && !(rowVal < f.val)) filterPass = false;
                    if (f.op === '=' && !(rowVal === f.val)) filterPass = false;
                    if (f.op === '!=' && !(rowVal !== f.val)) filterPass = false;
                    if (!filterPass) break;
                }
                if (!filterPass) continue;

                const xVal = r[xKey];
                if (xVal == null || isNaN(xVal)) continue;

                let rowOutput = null;
                if (customFn) {
                    try {
                        rowOutput = customFn(r);
                    } catch (err) {
                        throw new Error(`Algorithm Error at row ${i}: ${err.message}`);
                    }
                } else {
                    rowOutput = {};
                    for (const k of yKeys) {
                        rowOutput[k] = r[k];
                    }
                }

                if (ySeriesObj === null && rowOutput != null) {
                    ySeriesObj = {};
                    if (typeof rowOutput === 'object' && !Array.isArray(rowOutput)) {
                        for (const k of Object.keys(rowOutput)) ySeriesObj[k] = [];
                    } else {
                        ySeriesObj['Output'] = [];
                    }
                }

                let rowValid = true;
                if (typeof rowOutput === 'object' && rowOutput !== null && !Array.isArray(rowOutput)) {
                    for (const k of Object.keys(ySeriesObj)) {
                        const v = rowOutput[k];
                        if (v == null || isNaN(v) || !isFinite(v)) { rowValid = false; break; }
                    }
                } else {
                    if (rowOutput == null || isNaN(rowOutput) || !isFinite(rowOutput)) rowValid = false;
                }

                if (rowValid) {
                    let rowHlColor = null;
                    for (const h of highlights) {
                        const rowVal = r[h.key];
                        if (rowVal == null) continue;
                        let match = false;
                        if (h.op === '>' && rowVal > h.val) match = true;
                        if (h.op === '<' && rowVal < h.val) match = true;
                        if (h.op === '=' && rowVal === h.val) match = true;
                        if (h.op === '!=' && rowVal !== h.val) match = true;
                        if (match) { rowHlColor = h.color; break; }
                    }

                    xData.push(xVal);
                    hlData.push(rowHlColor);

                    if (typeof rowOutput === 'object' && !Array.isArray(rowOutput)) {
                        for (const k of Object.keys(ySeriesObj)) ySeriesObj[k].push(rowOutput[k]);
                    } else {
                        ySeriesObj['Output'].push(rowOutput);
                    }
                    validPoints++;
                }
            }

            if (validPoints === 0 || !ySeriesObj) throw new Error("Resulting dataset has 0 valid points after filtering.");

            if (smoothType === 'sma') {
                for (const k of Object.keys(ySeriesObj)) {
                    ySeriesObj[k] = self.HA.sma(ySeriesObj[k], smoothWindow);
                }
            }

            self.postMessage({
                id,
                type: 'SUCCESS',
                payload: { xData, ySeriesObj, validPoints, hlData }
            });
        }
        else if (type === 'PROCESS_DEEP_ML') {
            const { data, modelType, targetVar, targetName, windowSize, lr, epochs, trees, depth, degree } = payload;

            const featureVars = payload.featureVars || ['speed_kmh'];
            let parsedData = data;
            if (windowSize && typeof windowSize === 'number' && windowSize < data.length) {
                parsedData = data.slice(-windowSize);
            }

            let X = [], y = [], xData = [];

            for (let i = 0; i < parsedData.length; i++) {
                const r = parsedData[i];
                const ts = r._ts;
                if (ts == null) continue;

                // Typical ML multi-dimensional mathematical features matrix definition
                // For Polynomial Extrapolation, we add time itself as a key tracking feature so it correctly continuously projects mathematical sequences
                let feats = [];
                for (let f = 0; f < featureVars.length; f++) {
                    feats.push(r[featureVars[f]] || 0);
                }
                feats.push(i); // Explicit time/step index representation

                const target = r[targetVar];
                if (target == null || isNaN(target)) continue;

                X.push(feats);
                y.push(target);
                xData.push(ts);
            }

            if (X.length < 10) throw new Error("Insufficient numeric data points available to train a heavy model.");

            let predictFn = null;
            if (modelType === 'random-forest') {
                let boundedTrees = Math.min(Math.max(trees, 1), 200);
                let boundedDepth = Math.min(Math.max(depth, 1), 30);
                predictFn = self.HA.ai.trainRandomForest(X, y, boundedTrees, boundedDepth);
            } else if (modelType === 'gb-regressor') {
                let boundedTrees = Math.min(Math.max(trees, 1), 300);
                let boundedDepth = Math.min(Math.max(depth, 1), 15);
                predictFn = self.HA.ai.trainGBRegressor(X, y, boundedTrees, boundedDepth, lr);
            } else if (modelType === 'poly-regression') {
                let boundedDegree = Math.min(Math.max(degree, 1), 5); // Exponent degree capped to avoid JS Infinity math 
                predictFn = self.HA.ai.trainPolyRegression(X, y, boundedDegree, 200, 0.005);
            } else if (modelType === 'lstm-rnn') {
                // Neural net regressor execution (backpropagation)
                let epochsBounded = Math.min(Math.max(epochs, 10), 1000);
                predictFn = self.HA.ai.trainNeuralNet(X, y, epochsBounded, lr, 12);
            } else {
                throw new Error("Unknown Deep Model type requested.");
            }

            // Generate Output Arrays & Explicit Regressive Metrics
            let actualArr = [], predictArr = [];
            let sumY = 0, sumErrSq = 0, sumAbsErr = 0;

            for (let i = 0; i < X.length; i++) {
                const yi = y[i];
                const pi = predictFn(X[i]);

                actualArr.push(yi);
                predictArr.push(pi);

                sumY += yi;
                sumErrSq += (yi - pi) ** 2;
                sumAbsErr += Math.abs(yi - pi);
            }

            const meanY = sumY / X.length;
            let sumTotSq = 0;
            for (let i = 0; i < X.length; i++) sumTotSq += (y[i] - meanY) ** 2;

            const mse = sumErrSq / X.length;
            const mae = sumAbsErr / X.length;
            const r2 = sumTotSq === 0 ? 1 : (1 - (sumErrSq / sumTotSq));

            // Extract explicit multivariate weights simulation
            let formulaStr = `Model Mathematical Architecture:<br/>`;
            if (modelType === 'poly-regression') {
                formulaStr += `f(x) = β₀ + β₁x + β₂x² ... (Polynomial Projection)<br/>`;
            } else if (modelType === 'lstm-rnn') {
                formulaStr += `NN propagation complete. Activation sigmoids converged.<br/>`;
            } else {
                formulaStr += `Ensemble Construction Complete. Trees Iterated.<br/>`;
            }
            formulaStr += `<br/><span style="color:var(--ha-text3);">Feature Sensitivity (linearized from covariance/variance):</span><br/>`;
            for (let f = 0; f < featureVars.length; f++) {
                let sumF = 0;
                for (let i = 0; i < X.length; i++) sumF += X[i][f];
                let meanF = sumF / X.length;

                let covSum = 0, varF = 0;
                for (let i = 0; i < X.length; i++) {
                    let diffF = X[i][f] - meanF;
                    let diffY = y[i] - meanY;
                    covSum += (diffF * diffY);
                    varF += (diffF * diffF);
                }
                let weight = (varF > 0) ? covSum / varF : 0;
                formulaStr += `<span style="color:var(--ha-purple);">+ W[${f}] ${featureVars[f].padEnd(12)}:</span> ${weight.toFixed(5)}<br/>`;
            }

            const metrics = {
                mse: mse.toFixed(2),
                mae: mae.toFixed(2),
                r2: r2.toFixed(3),
                dims: X[0].length,
                formula: formulaStr
            };

            if (payload.doExtrap) {
                // Generative AI Prediction Extrapolation
                let lastTs = xData[xData.length - 1];
                let numSteps = 50;
                let patternWindow = Math.min(X.length, numSteps);
                let recentPattern = X.slice(-patternWindow);

                // We'll calculate a macro trend (over entire windowSize) to subtly shift the pattern
                let trends = [];
                for (let f = 0; f < featureVars.length; f++) {
                    let trendSum = 0;
                    let trendPoints = Math.min(30, X.length - 1);
                    if (trendPoints > 1) {
                        for (let w = 0; w < trendPoints; w++) {
                            trendSum += (X[X.length - 1 - w][f] - X[X.length - 2 - w][f]);
                        }
                        trends.push(trendSum / trendPoints);
                    } else {
                        trends.push(0);
                    }
                }

                for (let step = 1; step <= numSteps; step++) {
                    lastTs += 1000; // 1s
                    xData.push(lastTs);
                    actualArr.push("-"); // Leave gap for rendering 

                    // Get the corresponding historical point to replay its micro-oscillations perfectly
                    let basePatternIdx = step % patternWindow;
                    if (basePatternIdx === 0) basePatternIdx = patternWindow; // 1-indexed fallback
                    let patternPoint = recentPattern[basePatternIdx - 1];

                    let nextFeats = [];
                    for (let f = 0; f < featureVars.length; f++) {
                        // Replay the exact micro-oscillation + apply smooth macro momentum multiplied by the temporal step
                        let extrapolatedVal = patternPoint[f] + (trends[f] * step * 0.5);
                        nextFeats.push(extrapolatedVal);
                    }

                    // The last feature is exactly the sequential time multiplier (i) tracking relative sequence location
                    nextFeats.push(X[X.length - 1][featureVars.length] + step);

                    predictArr.push(predictFn(nextFeats));
                }
            }

            let ySeriesObj = {};
            ySeriesObj[`${targetName} (Actual)`] = actualArr;
            ySeriesObj[`${targetName} (AI Prediction)`] = predictArr;

            self.postMessage({
                id,
                type: 'SUCCESS',
                payload: { xData, ySeriesObj, validPoints: X.length, hlData: [], metrics }
            });
        }
        else {
            self.postMessage({ id, type: 'ERROR', error: 'Unknown task type: ' + type });
        }
    } catch (err) {
        self.postMessage({ id, type: 'ERROR', error: err.message });
    }
};
