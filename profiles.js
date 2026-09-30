// ─── Material Presets ───────────────────────────────────────────────────────
const MATERIALS = {
    PLA:  { density: 1.24, defaultColor: '#4f8ef7' },
    PETG: { density: 1.27, defaultColor: '#3ecf8e' },
    ABS:  { density: 1.04, defaultColor: '#e05260' },
    ASA:  { density: 1.05, defaultColor: '#f5a623' },
    TPU:  { density: 1.21, defaultColor: '#a855f7' },
};

// ─── Printer Machine Calibration ────────────────────────────────────────────
const PRINTER_MACHINES = {
    bambu_x1c: { name: "Bambu Lab X1C / P1S", factor: 1.00, prepTime: 6.0, bed: [256, 256, 256] },
    bambu_a1:  { name: "Bambu Lab A1", factor: 1.05, prepTime: 5.5, bed: [256, 256, 256] },
    prusa_mk4: { name: "Prusa MK4", factor: 1.20, prepTime: 3.5, bed: [250, 210, 220] },
    ender_3:   { name: "Creality Ender 3", factor: 1.45, prepTime: 3.0, bed: [220, 220, 250] }
};

// ─── Slicer Profile Presets ─────────────────────────────────────────────────
const PRESET_PROFILES = {
    custom: { name: "Custom" },
    bambu_x1c_020_standard: {
        name: "0.20mm Standard @BBL X1C",
        printer: "bambu_x1c",
        layerHeight: 0.2,
        maxFlow: 15,
        infillDensity: 30,
        overhead: 25,
        shells: { wallLoops: 2, topLayers: 5, bottomLayers: 3 },
        lineWidth: { outer: 0.42, inner: 0.45, infill: 0.45, topBottom: 0.42 },
        speed: { outer: 200, inner: 300, infill: 270, top: 200, bottom: 250 },
        supportEnabled: true,
        supportOverhead: 15,
    },
};
