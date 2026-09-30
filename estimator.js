/**
 * Print Estimator for Time and Material Usage
 */
class PrintEstimator {
    
    static estimate(geometryData, config) {
        const volume = geometryData.volume; // mm³
        const area = geometryData.area;     // mm²

        // 1. Classify Surface Area using actual mesh normals
        //    horizontalArea = faces within ~60° of flat  → top/bottom shells
        //    verticalArea   = steeper faces              → walls
        //    (falls back to bounding-box estimate for old parser output)
        let topBottomAreaApprox, wallAreaApprox;
        if (geometryData.horizontalArea !== undefined) {
            topBottomAreaApprox = geometryData.horizontalArea;
            wallAreaApprox      = geometryData.verticalArea;
        } else {
            // Legacy fallback
            topBottomAreaApprox = 2 * (geometryData.bounds.width * geometryData.bounds.depth);
            wallAreaApprox      = Math.max(0, area - topBottomAreaApprox);
        }

        // 2. Calculate Theoretical Shell Volumes
        const lh = config.layerHeight;
        const lw = config.lineWidth;
        
        let outerWallVol = wallAreaApprox * (1 * lw.outer);
        let innerWallVol = wallAreaApprox * (Math.max(0, config.shells.wallLoops - 1) * lw.inner);
        
        let topVol = (topBottomAreaApprox / 2) * (config.shells.topLayers * lh);
        let bottomVol = (topBottomAreaApprox / 2) * (config.shells.bottomLayers * lh);

        let rawShellVol = outerWallVol + innerWallVol + topVol + bottomVol;
        
        // Scale down if shells exceed total volume (e.g. solid part)
        if (rawShellVol > volume && rawShellVol > 0) {
            const ratio = volume / rawShellVol;
            outerWallVol *= ratio;
            innerWallVol *= ratio;
            topVol *= ratio;
            bottomVol *= ratio;
            rawShellVol = volume;
        }

        const internalVolume = volume - rawShellVol;
        const infillVolume = internalVolume * (config.infillDensity / 100.0);
        
        // 3. Volumetric Flow Rates & Time
        const getFlow = (speed, width) => Math.min(speed * lh * width, config.maxFlow);
        
        const qOuter = getFlow(config.speed.outer, lw.outer);
        const qInner = getFlow(config.speed.inner, lw.inner);
        const qTop = getFlow(config.speed.top, lw.topBottom);
        const qBottom = getFlow(config.speed.bottom, lw.topBottom);
        const qInfill = getFlow(config.speed.infill, lw.infill);

        const timeOuter = qOuter > 0 ? outerWallVol / qOuter : 0;
        const timeInner = qInner > 0 ? innerWallVol / qInner : 0;
        const timeTop = qTop > 0 ? topVol / qTop : 0;
        const timeBottom = qBottom > 0 ? bottomVol / qBottom : 0;
        const timeInfill = qInfill > 0 ? infillVolume / qInfill : 0;

        let baseTimeSeconds = timeOuter + timeInner + timeTop + timeBottom + timeInfill;

        // Complexity multiplier — accounts for acceleration/deceleration losses,
        // short path segments, and retractions that volumetric flow models cannot
        // capture without kinematic simulation.
        //
        // Dimensionless Shape Factor (Specific Surface Ratio):
        // Psi = Area / (Volume^(2/3))
        // Sphere = 4.84, Cube = 6.0, Cylinder = 5.54.
        // Thin-walled/organic/scoop models have high Psi (e.g. ~45+).
        // ── 2b. Geometry & Sparse Slice Topology Refinement ─────────────────
        // Sparse Slice Profiling provides real island count and vase detection in <5ms.
        const sliceProf = geometryData.sliceProfile || { avgIslandCount: 1.0, isVaseLike: false };
        const avgIslands = sliceProf.avgIslandCount;
        const isVaseLike = sliceProf.isVaseLike;

        let complexityFactor = 1.0;
        if (!config.complexity || config.complexity === 'auto') {
            if (isVaseLike) {
                // Continuous perimeter loop (e.g. spiral vase / pen holder):
                // Smooth toolpath with zero island hopping or retractions.
                complexityFactor = 1.05;
            } else if (volume > 0) {
                const psi = area / Math.pow(volume, 2/3);
                const excess = Math.max(0, psi - 6.0);
                complexityFactor = Math.min(2.2, 1.0 + 0.016 * excess);
            }
        } else {
            const COMPLEXITY_MULT = { geometric: 1.0, mechanical: 1.35, organic: 1.85 };
            complexityFactor = COMPLEXITY_MULT[config.complexity] || 1.0;
        }
        baseTimeSeconds *= complexityFactor;

        // 3. Layer Count & Minimum Cooling Time Floor
        const height = geometryData.bounds ? geometryData.bounds.height : 0;
        const totalLayers = Math.max(1, Math.ceil(height / lh));
        const minLayerTime = config.minLayerTime !== undefined ? config.minLayerTime : 7.0; // 7s standard cooling floor
        const minCoolingTimeSeconds = totalLayers * minLayerTime;

        // Apply layer cooling floor: if average layer time is below cooling threshold, machine slows down
        let effectiveExtrusionTime = Math.max(baseTimeSeconds, minCoolingTimeSeconds);

        let totalMaterialVolume = rawShellVol + infillVolume;
        let supportTimeSeconds = 0;
        let supportVolumeMm3 = 0;

        // 4. Overhang-based Supports
        if (config.supportEnabled) {
            if (geometryData.supportVolume && geometryData.supportVolume > 0) {
                supportVolumeMm3 = geometryData.supportVolume;
            } else {
                supportVolumeMm3 = totalMaterialVolume * ((config.supportOverhead || 15) / 100.0);
            }
            const supportFlow = config.maxFlow || 15;
            supportTimeSeconds = supportVolumeMm3 / supportFlow;
            totalMaterialVolume += supportVolumeMm3;
        }

        // Convert mm³ to cm³ (divide by 1000)
        const modelVolumeCm3 = (rawShellVol + infillVolume) / 1000.0;
        const supportVolumeCm3 = supportVolumeMm3 / 1000.0;
        const volumeCm3 = totalMaterialVolume / 1000.0;

        const modelWeightGrams = modelVolumeCm3 * config.materialDensity;
        const supportWeightGrams = supportVolumeCm3 * config.materialDensity;
        const weightGrams = volumeCm3 * config.materialDensity;

        // 5. Machine Overhead (Travels, Retractions, Z-hops)
        // Scaled dynamically by measured island count:
        // Single continuous loops (vases) have minimal travel (~10%);
        // Multi-branch trees (10+ islands) incur significant retraction/travel penalties.
        let dynamicOverheadPct = config.overhead || 25;
        if (isVaseLike) {
            dynamicOverheadPct = Math.min(12, dynamicOverheadPct * 0.5);
        } else if (avgIslands > 1.5) {
            const islandPenalty = Math.min(1.6, 1.0 + 0.08 * (avgIslands - 1));
            dynamicOverheadPct *= islandPenalty;
        }

        const overheadTimeSeconds = (effectiveExtrusionTime + supportTimeSeconds) * (dynamicOverheadPct / 100.0);

        // 6. Printer Machine Calibration Factor (e.g. Bambu X1C = 1.0, Ender 3 = 1.45)
        const printerFactor = config.printerFactor !== undefined ? config.printerFactor : 1.0;
        const modelTimeSeconds = (effectiveExtrusionTime + supportTimeSeconds + overheadTimeSeconds) * printerFactor;

        // 7. Machine Preparation Time (Bed heating, leveling, vibration calibration)
        const prepTimeMinutes = config.prepTimeMinutes !== undefined ? config.prepTimeMinutes : 6.0;
        const prepTimeSeconds = prepTimeMinutes * 60;

        const totalTimeSeconds = modelTimeSeconds + prepTimeSeconds;

        // Format time
        const hours = Math.floor(totalTimeSeconds / 3600);
        const minutes = Math.floor((totalTimeSeconds % 3600) / 60);

        return {
            weightGrams: weightGrams,
            modelWeightGrams: modelWeightGrams,
            supportWeightGrams: supportWeightGrams,
            supportVolumeCm3: supportVolumeCm3,
            printTimeHours: hours,
            printTimeMinutes: minutes,
            totalTimeSeconds: totalTimeSeconds,
            effectiveVolumeCm3: volumeCm3,
            totalLayers: totalLayers,
            breakdown: {
                timeOuter,
                timeInner,
                timeTop,
                timeBottom,
                timeInfill,
                timeCoolingDelay: Math.max(0, minCoolingTimeSeconds - baseTimeSeconds),
                timeSupport: supportTimeSeconds,
                timeOverhead: overheadTimeSeconds,
                timePrep: prepTimeSeconds
            }
        };
    }

    static formatTime(hours, minutes) {
        if (hours === 0) return `${minutes}m`;
        return `${hours}h ${minutes}m`;
    }
}
