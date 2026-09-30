
// Automatically load SVG icons from icons/ directory so any updates to the files reflect immediately
async function loadToolbarIcons() {
    const iconMap = {
        'tool-rotate': 'icons/rotate.svg',
        'tool-lay-face': 'icons/lay-on-face.svg',
        'btn-auto-orient': 'icons/auto-orient.svg',
        'btn-gravity-fall': 'icons/gravity-fall.svg'
    };
    for (const [btnId, iconUrl] of Object.entries(iconMap)) {
        try {
            const res = await fetch(iconUrl + '?v=' + Date.now());
            if (!res.ok) continue;
            const svgText = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgText, 'image/svg+xml');
            const svgEl = doc.querySelector('svg');
            if (svgEl) {
                svgEl.setAttribute('class', 'svg-filled');
                svgEl.setAttribute('width', '28');
                svgEl.setAttribute('height', '28');
                // Ensure fill: currentColor on paths
                const paths = svgEl.querySelectorAll('path');
                paths.forEach(p => {
                    p.style.fill = 'currentColor';
                    p.style.stroke = 'none';
                });
                const btn = document.getElementById(btnId);
                const toolIcon = btn ? btn.querySelector('.tool-icon') : null;
                if (toolIcon) {
                    toolIcon.innerHTML = '';
                    toolIcon.appendChild(svgEl);
                }
            }
        } catch (e) {
            // Fallback to inline SVG in HTML
        }
    }
}

/**
 * app.js — 3D Print Management & Accurate Estimator
 * Features:
 * - Bambu Lab 256×256 mm Build Plate with 3D grid and corner guides
 * - Orientation tools: 90° X/Y/Z rotation and Auto Lay Flat
 * - Bed Facing selector (snap Bottom, Top, Front, Back, Left, Right to bed)
 * - Plate fit detector (alerts if model exceeds 256 mm boundary)
 * - 3MF / Job Data Export (packages orientation and slicer settings)
 * - Volumetric flow-rate estimation with layer cooling floors and prep allowance
 * - Mesh-normal overhang detection & support calculations
 * - Job details form (Team, Requester, Project, Priority, Date, Notes)
 */

document.addEventListener('DOMContentLoaded', () => {
    loadToolbarIcons();

    // ── State ────────────────────────────────────────────────────────────────
    const files = new Map();
    let selectedId = null;
    let nextId = 1;

    // ── Adaptive Performance Manager ─────────────────────────────────────────
    // Lightweight system: peek triangle cost BEFORE full parse, track runtime
    // FPS, warn on heavy loads. No hard blocks — budget is a soft recommendation.
    const PerformanceManager = {
        // Soft triangle budget (warn at WARN_AT fraction). Persisted in localStorage.
        BUDGET: 1_500_000,
        WARN_AT: 0.75,   // warn at 75% utilisation

        // Runtime FPS state (rolling 60-frame window)
        _fps: 60,
        _frameTimes: [],
        _lastFrame: 0,

        // ── Pre-parse triangle peek ───────────────────────────────────────────
        // Binary STL stores triangle count as uint32 at byte offset 80 — free
        // to read in ~0.01ms without a full parse. Returns null for ASCII STLs.
        peekTriangleCount(arrayBuffer) {
            if (!arrayBuffer || arrayBuffer.byteLength < 84) return null;
            // ASCII STL begins with "solid " — heuristic: small files that start
            // with the magic bytes are likely ASCII and we skip the peek.
            const header = new Uint8Array(arrayBuffer, 0, 6);
            const startsWithSolid = String.fromCharCode(...header) === 'solid ';
            if (startsWithSolid && arrayBuffer.byteLength < 200_000) return null;
            const count = new DataView(arrayBuffer).getUint32(80, true);
            // Sanity check: count must be consistent with file size
            // Binary STL: 84 header bytes + 50 bytes per triangle
            const expectedBytes = 84 + count * 50;
            if (Math.abs(expectedBytes - arrayBuffer.byteLength) > 100) return null;
            return count;
        },

        // Rough GPU memory estimate in MB for a given triangle count
        estimateMemoryMB(triangles) {
            // ~80 bytes/triangle: position + normals + index buffer
            return Math.round((triangles * 80) / (1024 * 1024));
        },

        // Evaluate adding N more triangles against the current scene load
        evaluate(additionalTriangles) {
            const current = this.currentSceneTriangles();
            const total   = current + additionalTriangles;
            const utilization = total / this.BUDGET;
            let status = 'safe';
            if (utilization >= 1.5)      status = 'critical';
            else if (utilization >= 1.0) status = 'heavy';
            else if (utilization >= this.WARN_AT) status = 'warning';
            return { status, utilization, total, current };
        },

        // Sum triangles from all currently loaded entries
        currentSceneTriangles() {
            let n = 0;
            files.forEach(e => { if (e.triangles) n += e.triangles.length; });
            return n;
        },

        // Called every frame from the animate loop — maintains rolling FPS
        tick(now) {
            if (this._lastFrame > 0) {
                this._frameTimes.push(now - this._lastFrame);
                if (this._frameTimes.length > 60) this._frameTimes.shift();
                const avg = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
                this._fps = Math.round(1000 / avg);
            }
            this._lastFrame = now;
        },

        get fps() { return this._fps; },

        // Persist budget override to localStorage
        loadBudget() {
            try {
                const s = JSON.parse(localStorage.getItem('agy_perf') || '{}');
                if (s.budget && Number.isFinite(s.budget) && s.budget > 0) this.BUDGET = s.budget;
            } catch (e) {}
        },
        saveBudget(budget) {
            this.BUDGET = budget;
            try { localStorage.setItem('agy_perf', JSON.stringify({ budget })); } catch (e) {}
        }
    };
    PerformanceManager.loadBudget();

    // ── 3D Offscreen Thumbnail Renderer (Objects & Build Plates) ─────────────
    const ThumbnailRenderer = {
        _renderer: null,
        _scene: null,
        _camera: null,
        _canvas: null,

        init() {
            if (this._renderer) return;
            try {
                this._canvas = document.createElement('canvas');
                this._canvas.width = 128;
                this._canvas.height = 128;
                this._renderer = new THREE.WebGLRenderer({
                    canvas: this._canvas,
                    antialias: true,
                    alpha: true,
                    preserveDrawingBuffer: true
                });
                this._renderer.setSize(128, 128);
                this._renderer.setPixelRatio(1);
                this._scene = new THREE.Scene();
                this._camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);

                const amb = new THREE.AmbientLight(0xffffff, 0.95);
                const dir1 = new THREE.DirectionalLight(0xffffff, 0.85);
                dir1.position.set(2, 3, 2.5);
                const dir2 = new THREE.DirectionalLight(0x7090bb, 0.4);
                dir2.position.set(-2, -1, -2);
                this._scene.add(amb);
                this._scene.add(dir1);
                this._scene.add(dir2);
            } catch (e) {
                console.warn('Offscreen thumbnail renderer initialization failed:', e);
            }
        },

        captureModel(entry) {
            if (!entry || !entry.triangles || entry.triangles.length === 0) return null;
            try {
                this.init();
                if (!this._renderer) return null;

                const geo = buildGeometryFromTriangles(entry.triangles);
                geo.computeBoundingSphere();
                const sphere = geo.boundingSphere;
                const radius = sphere ? Math.max(sphere.radius, 1) : 25;

                const mat = new THREE.MeshStandardMaterial({
                    color: entry.config ? entry.config.color : '#00ae42',
                    roughness: 0.35,
                    metalness: 0.15
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.rotation.x = -Math.PI / 2;

                const group = new THREE.Group();
                group.add(mesh);
                this._scene.add(group);

                const dist = radius * 2.35;
                this._camera.position.set(dist * 0.82, dist * 0.72, dist * 0.95);
                this._camera.lookAt(0, 0, 0);

                this._renderer.render(this._scene, this._camera);
                const dataUrl = this._canvas.toDataURL('image/png');

                this._scene.remove(group);
                geo.dispose();
                mat.dispose();

                entry.thumbnailUrl = dataUrl;
                return dataUrl;
            } catch (err) {
                console.warn('Thumbnail generation failed for model:', err);
                return null;
            }
        },

        capturePlate(plate) {
            if (!plate) return null;
            try {
                this.init();
                if (!this._renderer) return null;

                const plateGroup = new THREE.Group();

                // Bambu 256x256 Bed Surface
                const bedGeom = new THREE.BoxGeometry(256, 4, 256);
                const bedMat = new THREE.MeshStandardMaterial({
                    color: 0x181a20,
                    roughness: 0.8
                });
                const bedMesh = new THREE.Mesh(bedGeom, bedMat);
                bedMesh.position.y = -2;
                plateGroup.add(bedMesh);

                // Green bed border & grid
                const borderGeom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(256, 256));
                const borderMat = new THREE.LineBasicMaterial({ color: 0x00ae42, linewidth: 2 });
                const borderLine = new THREE.LineSegments(borderGeom, borderMat);
                borderLine.rotation.x = -Math.PI / 2;
                borderLine.position.y = 0.5;
                plateGroup.add(borderLine);

                const grid = new THREE.GridHelper(256, 8, 0x00ae42, 0x2e3544);
                grid.position.y = 0.6;
                plateGroup.add(grid);

                // Add placed parts
                if (plate.parts && plate.parts.length > 0) {
                    plate.parts.forEach(p => {
                        const entry = p.entry;
                        if (!entry || !entry.triangles) return;
                        const geo = buildGeometryFromTriangles(entry.triangles);
                        const mat = new THREE.MeshStandardMaterial({
                            color: entry.config ? entry.config.color : 0x00ae42,
                            roughness: 0.45,
                            metalness: 0.1
                        });
                        const partMesh = new THREE.Mesh(geo, mat);
                        partMesh.rotation.x = -Math.PI / 2;
                        const h = (entry.geometry && entry.geometry.bounds) ? entry.geometry.bounds.height : 20;
                        partMesh.position.set(0, h / 2, 0);

                        const partGroup = new THREE.Group();
                        partGroup.position.set(p.posX || 0, 0, p.posZ || 0);
                        if (p.rotY) partGroup.rotation.y = p.rotY;
                        partGroup.add(partMesh);

                        plateGroup.add(partGroup);
                    });
                }

                this._scene.add(plateGroup);

                this._camera.position.set(240, 280, 240);
                this._camera.lookAt(0, 0, 0);

                this._renderer.render(this._scene, this._camera);
                const dataUrl = this._canvas.toDataURL('image/png');

                this._scene.remove(plateGroup);
                plateGroup.traverse(child => {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) {
                        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                        else child.material.dispose();
                    }
                });

                plate.thumbnailUrl = dataUrl;
                return dataUrl;
            } catch (err) {
                console.warn('Plate thumbnail generation failed:', err);
                return null;
            }
        }
    };

    // ── DOM Refs ─────────────────────────────────────────────────────────────
    const fileInput      = document.getElementById('file-input');
    const fileList       = document.getElementById('file-list');
    const dropOverlay    = document.getElementById('drop-overlay');
    const viewerWrap     = document.getElementById('viewer-wrap');
    const viewerEmpty    = document.getElementById('viewer-empty');
    const detailsContent = document.getElementById('details-content');
    const noSelHint      = document.getElementById('no-selection-hint');
    const settingsForm   = document.getElementById('settings-form');
    const settingsEmpty  = document.getElementById('settings-empty');
    const toast          = document.getElementById('toast');

    // Bambu Studio Toolbar & Inspector refs
    const bambuToolbar   = document.getElementById('bambu-toolbar');
    const toolView       = document.getElementById('tool-view');
    const toolMove       = document.getElementById('tool-move');
    const toolRotate     = document.getElementById('tool-rotate');
    const toolScale      = document.getElementById('tool-scale');
    const toolLayFace    = document.getElementById('tool-lay-face');
    const btnAutoOrient  = document.getElementById('btn-auto-orient');
    const btnViewHome    = document.getElementById('btn-view-home');
    const btnViewTop     = document.getElementById('btn-view-top');
    const btnViewFront   = document.getElementById('btn-view-front');
    const btnViewRight   = document.getElementById('btn-view-right');
    const btnHomeView    = document.getElementById('btn-home-view');
    const plateFitBadge  = document.getElementById('plate-fit-badge');
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    const themeIcon      = document.getElementById('theme-icon');
    const themeText      = document.getElementById('theme-text');
    const viewCubeEl     = document.getElementById('view-cube');
    const cubeHomeBtn    = document.getElementById('cube-home-btn');
    const btnCamProjection = document.getElementById('btn-cam-projection');
    const camProjText    = document.getElementById('cam-projection-label');

    // Progress Modal refs
    const progressModal   = document.getElementById('progress-modal');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressStatus  = document.getElementById('progress-status');
    const progressPct     = document.getElementById('progress-pct');
    const progressDetail  = document.getElementById('progress-detail');

    // Bambu Inspector elements
    const bambuInspector = document.getElementById('bambu-inspector');
    const inpPosX        = document.getElementById('inp-pos-x');
    const inpPosY        = document.getElementById('inp-pos-y');
    const inpPosZ        = document.getElementById('inp-pos-z');
    const btnCenterModel = document.getElementById('btn-center-model');
    const btnResetRot    = document.getElementById('btn-reset-rot');
    const btnRotX        = document.getElementById('btn-rot-x');
    const btnRotY        = document.getElementById('btn-rot-y');
    const btnRotZ        = document.getElementById('btn-rot-z');
    const btnLayFlat     = document.getElementById('btn-lay-flat');
    const sBedFacing     = document.getElementById('s-bed-facing');
    const inpScalePct    = document.getElementById('inp-scale-pct');
    const chkUniformScale= document.getElementById('chk-uniform-scale');
    const btnResetScale  = document.getElementById('btn-reset-scale');
    const scaleDims      = document.getElementById('scale-dims');

    // Detail outputs
    const dTime          = document.getElementById('d-time');
    const dWeight        = document.getElementById('d-weight');
    const dCost          = document.getElementById('d-cost');
    const dLayers        = document.getElementById('d-layers');
    const dVolume        = document.getElementById('d-volume');
    const dBounds        = document.getElementById('d-bounds');
    const dPolygons      = document.getElementById('d-polygons');
    const dTopology      = document.getElementById('d-topology');
    const dOverhang      = document.getElementById('d-overhang');
    const dSupportWeight = document.getElementById('d-support-weight');

    // Settings inputs
    const sTeam          = document.getElementById('s-team');
    const sRequester     = document.getElementById('s-requester');
    const sProject       = document.getElementById('s-project');
    const sPriority      = document.getElementById('s-priority');
    const sDate          = document.getElementById('s-date');
    const sNotes         = document.getElementById('s-notes');
    const sMaterial      = document.getElementById('s-material');
    const sColor         = document.getElementById('s-color');
    const sDensity       = document.getElementById('s-density');
    const sPricePerKg    = document.getElementById('s-price-per-kg');
    const sPrinter       = document.getElementById('s-printer');
    const sPreset        = document.getElementById('s-preset');
    const sLayerHeight   = document.getElementById('s-layer-height');
    const sComplexity    = document.getElementById('s-complexity');
    const sPrepTime      = document.getElementById('s-prep-time');
    const sMinLayerTime  = document.getElementById('s-min-layer-time');
    const sWallLoops     = document.getElementById('s-wall-loops');
    const sTopLayers     = document.getElementById('s-top-layers');
    const sBotLayers     = document.getElementById('s-bottom-layers');
    const sLwOuter       = document.getElementById('s-lw-outer');
    const sLwInner       = document.getElementById('s-lw-inner');
    const sLwInfill      = document.getElementById('s-lw-infill');
    const sLwTopBot      = document.getElementById('s-lw-topbot');
    const sInfill        = document.getElementById('s-infill');
    const sMaxFlow       = document.getElementById('s-max-flow');
    const sSpdOuter      = document.getElementById('s-spd-outer');
    const sSpdInner      = document.getElementById('s-spd-inner');
    const sSpdInfill     = document.getElementById('s-spd-infill');
    const sSpdTop        = document.getElementById('s-spd-top');
    const sSpdBot        = document.getElementById('s-spd-bot');
    const sSupports      = document.getElementById('s-supports');
    const sSupportPct    = document.getElementById('s-support-pct');
    const sSupportRow    = document.getElementById('s-support-pct-row');
    const sOverhead      = document.getElementById('s-overhead');
    const btnReset       = document.getElementById('btn-reset');
    const btnSubmit      = document.getElementById('btn-submit');
    const btnExportJob   = document.getElementById('btn-export-job');
    const btnOpenJobInfo = document.getElementById('btn-open-job-info');
    const jobModal       = document.getElementById('job-modal');
    const btnConfirmSubmit = document.getElementById('btn-confirm-submit');
    const btnCloseJobModal = document.getElementById('btn-close-job-modal');
    const btnCancelJobModal= document.getElementById('btn-cancel-job-modal');

    // Requirements & Layout DOM refs
    const sObjectName     = document.getElementById('s-object-name');
    const sPartComments   = document.getElementById('s-part-comments');
    const sSeparatePlate  = document.getElementById('s-separate-plate');
    const btnProceedLayout= document.getElementById('btn-proceed-layout');
    const btnContinuePlates = document.getElementById('btn-topbar-continue-plates') || document.getElementById('btn-topbar-proceed-layout');
    const btnReviewSubmit   = document.getElementById('btn-topbar-review-submit');
    const btnSubmitFinal    = document.getElementById('btn-topbar-submit-final') || document.getElementById('btn-topbar-submit-job');
    const layoutModal     = document.getElementById('layout-modal');
    const btnCloseLayoutModal = document.getElementById('btn-close-layout-modal');
    const layoutTotalPlates   = document.getElementById('layout-total-plates');
    const layoutTotalParts    = document.getElementById('layout-total-parts');
    const layoutTotalTime     = document.getElementById('layout-total-time');
    const layoutTotalWeight   = document.getElementById('layout-total-weight');
    const layoutTotalCost     = document.getElementById('layout-total-cost');
    const layoutTabsBar       = document.getElementById('layout-tabs-bar');
    const layoutPlateContent  = document.getElementById('layout-plate-content');
    const btnViewPlate3d      = document.getElementById('btn-view-plate-3d');
    // 3-Step Workflow & Layouts View DOM refs
    const stepBtnObjects       = document.getElementById('step-btn-objects') || document.getElementById('tab-btn-objects');
    const stepBtnPlates        = document.getElementById('step-btn-plates') || document.getElementById('tab-btn-layouts');
    const stepBtnReview        = document.getElementById('step-btn-review');
    const checkObjects         = document.getElementById('check-objects');
    const checkPlates          = document.getElementById('check-plates');
    const badgeObjectsCount    = document.getElementById('badge-objects-count');
    const badgePlatesCount     = document.getElementById('badge-plates-count');
    const objectsSidebarView   = document.getElementById('objects-sidebar-view');
    const layoutsSidebarView   = document.getElementById('layouts-sidebar-view');
    const sideTotalPlates      = document.getElementById('side-total-plates');
    const sideTotalParts       = document.getElementById('side-total-parts');
    const sideTotalTime        = document.getElementById('side-total-time');
    const sideTotalWeight      = document.getElementById('side-total-weight');
    const sideTotalCost        = document.getElementById('side-total-cost');
    const buildPlatesTree      = document.getElementById('build-plates-tree');
    const btnCreatePlateTop    = document.getElementById('btn-create-plate-top');
    const btnCreatePlateBottom = document.getElementById('btn-create-plate-bottom');
    const btnTrayModeToggle    = document.getElementById('btn-tray-mode-toggle');
    const trayModeIcon         = document.getElementById('tray-mode-icon');
    const trayModeLabel        = document.getElementById('tray-mode-label');
    const needsReviewSection   = document.getElementById('needs-review-section');
    const needsReviewHeader    = document.getElementById('needs-review-header');
    const needsReviewCount     = document.getElementById('needs-review-count');
    const needsReviewList      = document.getElementById('needs-review-list');
    const plateNameInput       = document.getElementById('plate-name-input');
    const plateExportPreview   = document.getElementById('plate-export-preview');
    const plateBedUsageText    = document.getElementById('plate-bed-usage-text');
    const plateBedGaugeFill    = document.getElementById('plate-bed-gauge-fill');
    const btnPlateAutoArrange  = document.getElementById('btn-plate-auto-arrange');
    const btnPlateDelete       = document.getElementById('btn-plate-delete');
    const scopeHeaderStrip     = document.getElementById('scope-header-strip');
    const scopeBadge           = document.getElementById('scope-badge');
    const scopeTitle           = document.getElementById('scope-title');
    const reviewStageView      = document.getElementById('review-stage-view');
    const revTotalParts        = document.getElementById('rev-total-parts');
    const revTotalPlates       = document.getElementById('rev-total-plates');
    const revTotalTime         = document.getElementById('rev-total-time');
    const revTotalWeight       = document.getElementById('rev-total-weight');
    const revTotalCost         = document.getElementById('rev-total-cost');
    const revAlertUnassigned   = document.getElementById('rev-alert-unassigned');
    const reviewPlatesGrid     = document.getElementById('review-plates-grid');
    const btnRevBack           = document.getElementById('btn-rev-back');
    const btnRevSubmitJob      = document.getElementById('btn-rev-submit-job');
    const layoutContextMenu    = document.getElementById('layout-context-menu');
    const ctxPartTitle         = document.getElementById('ctx-part-title');
    const ctxPlateList         = document.getElementById('ctx-plate-list');

    // Layouts Viewport Tools & Settings DOM refs
    const toolsObjects         = document.getElementById('tools-objects');
    const toolsLayouts         = document.getElementById('tools-layouts');
    const toolLayoutMove       = document.getElementById('tool-layout-move');
    const toolLayoutRotate     = document.getElementById('tool-layout-rotate');
    const toolLayoutNest       = document.getElementById('tool-layout-nest');
    const plateSettingsForm    = document.getElementById('plate-settings-form');
    const plateSumTitle        = document.getElementById('plate-sum-title');
    const plateSumReason       = document.getElementById('plate-sum-reason');
    const plateSumMaterialBadge= document.getElementById('plate-sum-material-badge');
    const platePrinter         = document.getElementById('plate-printer');
    const plateMaterial        = document.getElementById('plate-material');
    const plateLayerHeight     = document.getElementById('plate-layer-height');
    const plateWallLoops       = document.getElementById('plate-wall-loops');
    const plateInfill          = document.getElementById('plate-infill');
    const plateSupports        = document.getElementById('plate-supports');
    const pmOccupancy          = document.getElementById('pm-occupancy');
    const pmParts              = document.getElementById('pm-parts');
    const pmWeight             = document.getElementById('pm-weight');
    const pmTime               = document.getElementById('pm-time');
    const pmCost               = document.getElementById('pm-cost');
    const plateNotes           = document.getElementById('plate-notes');
    const btnSubmitPlateDirect = document.getElementById('btn-submit-plate-direct');

    // ── Application Mode State ───────────────────────────────────────────────
    let currentMode = 'objects'; // 'objects' | 'layouts'
    let layoutPlateGroup = null;
    let currentLayoutTool = 'translate'; // 'translate' | 'rotate'
    let selectedLayoutMesh = null;
    let compassGizmo = null;
    let isDraggingCompass = false;
    let compassStartAngle = 0;
    let compassStartPartRot = 0;
    const compassBedPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.35);
    const compassPlaneIntersect = new THREE.Vector3();
    const compassTooltip = document.getElementById('compass-angle-tooltip');
    const compassAngleVal = document.getElementById('compass-angle-val');

    // ── Toast Helper ─────────────────────────────────────────────────────────
    let toastTimer;
    function showToast(msg, type = '', duration = 3000) {
        toast.textContent = msg;
        toast.className = `toast show ${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.className = 'toast'; }, duration);
    }

    // ── Clean Light / Dark Theme Setup ───────────────────────────────────────
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('bambu_theme', theme); } catch (e) {}
        if (themeText) {
            themeText.textContent = theme === 'light' ? 'Dark' : 'Light';
        }
        if (btnThemeToggle) {
            btnThemeToggle.setAttribute('data-tooltip', theme === 'light' ? 'Dark Theme' : 'Light Theme');
        }
    }

    // Default to clean light theme as requested by user
    const savedTheme = (function() {
        try { return localStorage.getItem('bambu_theme') || 'light'; }
        catch (e) { return 'light'; }
    })();
    setTheme(savedTheme);

    if (btnThemeToggle) {
        btnThemeToggle.addEventListener('click', () => {
            const curr = document.documentElement.getAttribute('data-theme') || 'light';
            const next = curr === 'light' ? 'dark' : 'light';
            setTheme(next);
            showToast(`Switched to ${next === 'light' ? 'Clean Light' : 'Dark'} theme`, 'info', 1500);
        });
    }

    // ── Three.js Viewer & Build Plate ────────────────────────────────────────
    // ── Three.js Viewer & Bambu Studio Build Plate ──────────────────────────
    let scene, camera, renderer, controls, buildPlateGroup;
    let perspectiveCamera, orthographicCamera;
    let currentCameraType = 'orthographic'; // 'orthographic' | 'perspective' (DEFAULT: Orthographic)
    const frustumSize = 340; // Base vertical frustum size in mm (comfortably fits 256x256 plate)
    let transformControls, selectionBox, _tempBox;
    let lastGizmoEndTime = 0;
    let downX = 0, downY = 0;
    let currentTool = 'view'; // 'view' | 'move' | 'rotate' | 'scale' | 'lay-face'
    let cameraAnim = null;
    let updateViewCube = () => {};
    const PLATE_SIZE = 256; // 256 x 256 mm (Bambu Lab Standard)

    function createBuildPlate() {
        const group = new THREE.Group();
        group.name = 'buildPlate';

        // 1. Bed Plate Solid Base (256 x 256 x 2.5 mm, top surface flush at Y = 0)
        // Authentic Bambu Lab textured PEI plate
        const bedGeo = new THREE.BoxGeometry(PLATE_SIZE, 2.5, PLATE_SIZE);
        const bedMat = new THREE.MeshStandardMaterial({
            color: 0x181a1f, // Bambu Lab dark charcoal PEI finish
            roughness: 0.85,
            metalness: 0.1,
            transparent: true,
            opacity: 0.45,
            depthWrite: false, // Prevents depth occlusion so model underside is fully visible
            side: THREE.DoubleSide
        });
        const bedMesh = new THREE.Mesh(bedGeo, bedMat);
        bedMesh.position.y = -1.25;
        group.add(bedMesh);

        // 2. Build Area Edge Border (Bambu Green accent)
        const borderGeo = new THREE.EdgesGeometry(bedGeo);
        const borderMat = new THREE.LineBasicMaterial({
            color: 0x00ae42, // Bambu Lab signature green
            transparent: true,
            opacity: 0.75,
            linewidth: 1.5
        });
        const borderLine = new THREE.LineSegments(borderGeo, borderMat);
        borderLine.position.y = -1.25;
        group.add(borderLine);

        // 3. Grid Lines on Bed (subdivisions every 16mm = 16 grid squares)
        const grid = new THREE.GridHelper(PLATE_SIZE, 16, 0x00ae42, 0x2e3340);
        grid.material.transparent = true;
        grid.material.opacity = 0.45;
        grid.position.y = 0.05; // Slightly above bed surface to avoid z-fighting
        group.add(grid);

        // 4. Bambu Build Plate Tab with 3D Plate Name Label Extension
        const tabWidth = 58;
        const tabDepth = 14;
        const tabGeo = new THREE.BoxGeometry(tabWidth, 2.7, tabDepth);
        const tabMat = new THREE.MeshStandardMaterial({
            color: 0x00ae42, // Bambu Lab signature emerald green
            roughness: 0.35,
            metalness: 0.15
        });
        const tab = new THREE.Mesh(tabGeo, tabMat);
        tab.position.set(-82, -1.25, 128 + (tabDepth / 2));
        group.add(tab);

        // 3D Canvas Text Label on the green tab extension
        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = 256;
        labelCanvas.height = 64;
        const labelTex = new THREE.CanvasTexture(labelCanvas);
        labelTex.minFilter = THREE.LinearFilter;
        const labelMat = new THREE.MeshBasicMaterial({
            map: labelTex,
            transparent: true,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
        });
        const labelGeo = new THREE.PlaneGeometry(tabWidth - 4, tabDepth - 2);
        const labelMesh = new THREE.Mesh(labelGeo, labelMat);
        labelMesh.name = 'plateTabLabelMesh';
        labelMesh.rotation.x = -Math.PI / 2; // Lie perfectly flat on top of the tab
        labelMesh.position.set(-82, 0.15, 128 + (tabDepth / 2));
        group.add(labelMesh);

        group.userData.labelCanvas = labelCanvas;
        group.userData.labelTexture = labelTex;

        // 5. Bambu Front Alignment Lip Tab
        const frontTabGeo = new THREE.BoxGeometry(42, 2.7, 6);
        const frontTabMat = new THREE.MeshStandardMaterial({
            color: 0x242830,
            roughness: 0.5
        });
        const frontTab = new THREE.Mesh(frontTabGeo, frontTabMat);
        frontTab.position.set(0, -1.25, -128 - 3);
        group.add(frontTab);

        setTimeout(() => update3DPlateLabel('OBJECT'), 50);

        return group;
    }

    function update3DPlateLabel(text = 'OBJECT') {
        const buildPlateGroup = scene ? scene.getObjectByName('buildPlate') : null;
        if (!buildPlateGroup || !buildPlateGroup.userData.labelCanvas) return;
        const canvas = buildPlateGroup.userData.labelCanvas;
        const tex = buildPlateGroup.userData.labelTexture;
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, 256, 64);

        // Dark pill background with emerald green border
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.roundRect(4, 4, 248, 56, 12);
        ctx.fill();

        ctx.lineWidth = 4;
        ctx.strokeStyle = '#00ae42';
        ctx.stroke();

        // High contrast bold white text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const display = (text || 'OBJECT').toUpperCase();
        ctx.fillText(display, 128, 32);

        tex.needsUpdate = true;
    }

    // Instantaneous Camera Snapper / Animator
    function animateCameraTo(targetPos, targetLookAt, duration = 0, onComplete) {
        if (cameraAnim) {
            cancelAnimationFrame(cameraAnim);
            cameraAnim = null;
        }
        if (duration <= 0) {
            camera.position.copy(targetPos);
            controls.target.copy(targetLookAt);
            controls.update();
            updateViewCube();
            if (onComplete) onComplete();
            return;
        }
        const startPos = camera.position.clone();
        const startLookAt = controls.target.clone();
        const startTime = performance.now();

        function step(now) {
            const elapsed = now - startTime;
            const t = Math.min(1, elapsed / duration);
            const ease = 1 - Math.pow(1 - t, 3);

            camera.position.lerpVectors(startPos, targetPos, ease);
            controls.target.lerpVectors(startLookAt, targetLookAt, ease);
            controls.update();

            if (t < 1) {
                cameraAnim = requestAnimationFrame(step);
            } else {
                cameraAnim = null;
                if (onComplete) onComplete();
            }
        }
        cameraAnim = requestAnimationFrame(step);
    }

    function viewHome() {
        if (!controls || !camera) return;
        const entry = selectedId ? files.get(selectedId) : null;
        const b = entry && entry.geometry ? entry.geometry.bounds : { width: 100, depth: 100, height: 100 };
        const maxDim = Math.max(PLATE_SIZE, b.width, b.depth, b.height);
        const dist = maxDim * 1.35;
        const targetPos = new THREE.Vector3(dist * 0.8, dist * 0.75, dist * 0.95);
        if (camera.isOrthographicCamera) {
            camera.zoom = frustumSize / (maxDim * 1.35);
            camera.updateProjectionMatrix();
        }
        animateCameraTo(targetPos, new THREE.Vector3(0, 0, 0), 0);
    }

    function viewTop() {
        if (!controls || !camera) return;
        const dist = PLATE_SIZE * 1.35;
        const targetPos = new THREE.Vector3(0, dist, 0.001);
        animateCameraTo(targetPos, new THREE.Vector3(0, 0, 0), 0);
    }

    function viewFront() {
        if (!controls || !camera) return;
        const dist = PLATE_SIZE * 1.35;
        const targetPos = new THREE.Vector3(0, 25, dist);
        animateCameraTo(targetPos, new THREE.Vector3(0, 20, 0), 0);
    }

    function viewRight() {
        if (!controls || !camera) return;
        const dist = PLATE_SIZE * 1.35;
        const targetPos = new THREE.Vector3(dist, 25, 0);
        animateCameraTo(targetPos, new THREE.Vector3(0, 20, 0), 0);
    }

    function viewLeft() {
        if (!controls || !camera) return;
        const dist = PLATE_SIZE * 1.35;
        const targetPos = new THREE.Vector3(-dist, 25, 0);
        animateCameraTo(targetPos, new THREE.Vector3(0, 20, 0), 0);
    }

    function viewBack() {
        if (!controls || !camera) return;
        const dist = PLATE_SIZE * 1.35;
        const targetPos = new THREE.Vector3(0, 25, -dist);
        animateCameraTo(targetPos, new THREE.Vector3(0, 20, 0), 0);
    }

    function viewBottom() {
        if (!controls || !camera) return;
        const dist = PLATE_SIZE * 1.35;
        const targetPos = new THREE.Vector3(0, -dist, 0.001);
        animateCameraTo(targetPos, new THREE.Vector3(0, 0, 0), 0);
    }

    function updateCameraProjectionUI() {
        if (!btnCamProjection) return;
        if (camProjText) {
            camProjText.textContent = currentCameraType === 'orthographic' ? 'ORTHO' : 'PERSP';
        }
        btnCamProjection.dataset.projection = currentCameraType;
        if (currentCameraType === 'orthographic') {
            btnCamProjection.setAttribute('data-tooltip', 'Camera: Orthographic (Click for Perspective)');
            btnCamProjection.setAttribute('aria-label', 'Camera: Orthographic (Click for Perspective)');
        } else {
            btnCamProjection.setAttribute('data-tooltip', 'Camera: Perspective (Click for Orthographic)');
            btnCamProjection.setAttribute('aria-label', 'Camera: Perspective (Click for Orthographic)');
        }
    }

    function setCameraProjection(type) {
        if (!perspectiveCamera || !orthographicCamera) return;
        if (type !== 'perspective' && type !== 'orthographic') return;
        if (type === currentCameraType && camera) return;

        const prevCam = camera;
        currentCameraType = type;

        if (type === 'orthographic') {
            // Perspective -> Orthographic
            const d = prevCam ? prevCam.position.distanceTo(controls.target) : 380;
            const fovRad = ((perspectiveCamera.fov || 45) * Math.PI) / 180;
            const visibleHeight = Math.max(2 * d * Math.tan(fovRad / 2), 10);
            orthographicCamera.zoom = frustumSize / visibleHeight;
            orthographicCamera.position.copy(perspectiveCamera.position);
            orthographicCamera.quaternion.copy(perspectiveCamera.quaternion);
            orthographicCamera.updateProjectionMatrix();
            camera = orthographicCamera;
        } else {
            // Orthographic -> Perspective
            const currentZoom = Math.max(orthographicCamera.zoom || 1, 0.05);
            const visibleHeight = frustumSize / currentZoom;
            const fovRad = ((perspectiveCamera.fov || 45) * Math.PI) / 180;
            const targetDist = Math.max((visibleHeight / 2) / Math.tan(fovRad / 2), 20);

            const dir = new THREE.Vector3().subVectors(orthographicCamera.position, controls.target);
            if (dir.lengthSq() < 1e-4) {
                dir.set(0.6, 0.7, 0.6);
            }
            dir.normalize();
            perspectiveCamera.position.copy(controls.target).addScaledVector(dir, targetDist);
            perspectiveCamera.quaternion.copy(orthographicCamera.quaternion);
            perspectiveCamera.updateProjectionMatrix();
            camera = perspectiveCamera;
        }

        if (controls) {
            controls.object = camera;
            controls.update();
        }
        if (transformControls) {
            transformControls.camera = camera;
        }

        updateCameraProjectionUI();
    }

    function initViewer() {
        scene = new THREE.Scene();
        const w = viewerWrap.clientWidth || 800, h = viewerWrap.clientHeight || 600;
        const aspect = w / h;

        perspectiveCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 5000);
        perspectiveCamera.position.set(220, 200, 260);

        orthographicCamera = new THREE.OrthographicCamera(
            (-frustumSize * aspect) / 2,
            (frustumSize * aspect) / 2,
            frustumSize / 2,
            -frustumSize / 2,
            -2000,
            5000
        );
        orthographicCamera.position.set(220, 200, 260);
        orthographicCamera.zoom = 0.95;
        orthographicCamera.updateProjectionMatrix();

        // DEFAULT: Orthographic!
        camera = orthographicCamera;
        currentCameraType = 'orthographic';
        updateCameraProjectionUI();

        window.__getAppCamera = () => ({ camera, currentCameraType, perspectiveCamera, orthographicCamera, setCameraProjection });

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(window.devicePixelRatio);
        viewerWrap.appendChild(renderer.domElement);

        // Bambu Studio Immediate Navigation: Orbit, Pan, Zoom to Cursor (Zero Damping / Lag)
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false; // Zero damping / inertia for immediate 1:1 direct tracking
        controls.screenSpacePanning = true; // Screen space pan
        controls.zoomToCursor = true; // Zoom directly toward mouse pointer!
        controls.target.set(0, 0, 0); // Exact center of build plate
        controls.maxPolarAngle = Math.PI - 0.02; // Full 360° orbit around and under the bed
        controls.minDistance = 15;
        controls.maxDistance = 1800;

        // Bambu Studio Mouse Button Mapping:
        // - Left Click + Drag: Orbit / Rotate
        // - Middle Click (Scroll Wheel Drag): Pan
        // - Right Click + Drag: Pan
        // - Rotate Scroll Wheel: Zoom to cursor
        controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.PAN
        };
        viewerWrap.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            if (currentMode !== 'layouts' || !currentNesting || !layoutPlateGroup) return;

            const dragDist = Math.hypot(ev.clientX - downX, ev.clientY - downY);
            if (dragDist > 6) return;

            if (!renderer || !camera) return;
            const rect = renderer.domElement.getBoundingClientRect();
            if (ev.clientX < rect.left || ev.clientX > rect.right ||
                ev.clientY < rect.top || ev.clientY > rect.bottom) return;

            const mX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
            const mY = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            const rc = new THREE.Raycaster();
            rc.setFromCamera(new THREE.Vector2(mX, mY), camera);

            const hits = rc.intersectObjects(layoutPlateGroup.children, true);
            if (hits.length > 0) {
                let hitMesh = hits[0].object;
                while (hitMesh && !hitMesh.userData.isPlatePart && hitMesh.parent) {
                    hitMesh = hitMesh.parent;
                }
                if (hitMesh && hitMesh.userData && hitMesh.userData.isPlatePart) {
                    ev.stopPropagation();
                    selectLayoutPart(hitMesh);
                    const pIdx = hitMesh.userData.partIndex;
                    const pName = hitMesh.userData.entry ? hitMesh.userData.entry.name : 'Part';
                    showLayoutContextMenu(ev.clientX, ev.clientY, pIdx, pName);
                }
            }
        });

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const d1 = new THREE.DirectionalLight(0xffffff, 0.9);
        d1.position.set(100, 260, 150); scene.add(d1);
        const d2 = new THREE.DirectionalLight(0x8090ff, 0.4);
        d2.position.set(-120, -60, -100); scene.add(d2);
        // Under-bed light to illuminate model underside when looking through translucent bed
        const d3 = new THREE.DirectionalLight(0x90b0e8, 0.65);
        d3.position.set(0, -220, 60); scene.add(d3);

        // Add 256x256mm Bambu PEI build plate
        buildPlateGroup = createBuildPlate();
        scene.add(buildPlateGroup);

        // Bambu Studio Selection Box (Green Bounding Outline)
        selectionBox = new THREE.BoxHelper(new THREE.Mesh(new THREE.BufferGeometry()), 0x00ae42);
        selectionBox.visible = false;
        _tempBox = new THREE.Box3();
        scene.add(selectionBox);

        // Bambu Studio Interactive Transform Gizmo
        transformControls = new THREE.TransformControls(camera, renderer.domElement);
        transformControls.size = 0.85;
        transformControls.space = 'world';

        transformControls.addEventListener('dragging-changed', (ev) => {
            controls.enabled = !ev.value; // Disable OrbitControls while manipulating gizmo
            if (!ev.value) {
                lastGizmoEndTime = Date.now();
                onGizmoDragEnd();
            }
        });
        transformControls.addEventListener('mouseUp', () => {
            lastGizmoEndTime = Date.now();
        });

        transformControls.addEventListener('change', () => {
            onGizmoChange();
        });

        scene.add(transformControls);
        initCompassGizmo();

        function initCompassGizmo() {
            compassGizmo = new THREE.Group();
            compassGizmo.name = 'compassGizmo';
            compassGizmo.visible = false;

            // 1. Outer Blue Ring (horizontal on bed)
            const ringGeo = new THREE.BufferGeometry();
            const ringMat = new THREE.LineBasicMaterial({ color: 0x1e88e5, linewidth: 3 });
            const ringLine = new THREE.LineLoop(ringGeo, ringMat);
            ringLine.name = 'ringLine';
            compassGizmo.add(ringLine);

            // 2. Compass / Protractor Ticks (crisp white)
            const tickGeo = new THREE.BufferGeometry();
            const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
            const ticksLine = new THREE.LineSegments(tickGeo, tickMat);
            ticksLine.name = 'ticksLine';
            compassGizmo.add(ticksLine);

            // 3. Pointer line from center to handle
            const ptrGeo = new THREE.BufferGeometry();
            const ptrMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, linewidth: 2 });
            const pointerLine = new THREE.Line(ptrGeo, ptrMat);
            pointerLine.name = 'pointerLine';
            compassGizmo.add(pointerLine);

            // 4. Handle Group (Yellow Cube + Dual Cones)
            const handleGroup = new THREE.Group();
            handleGroup.name = 'handleGroup';

            const handleMat = new THREE.MeshStandardMaterial({
                color: 0xfbbf24,
                roughness: 0.25,
                metalness: 0.1
            });
            const handleBox = new THREE.Mesh(new THREE.BoxGeometry(5.2, 5.2, 5.2), handleMat);
            handleGroup.add(handleBox);

            // Cone 1 points forward along tangent (+Z) away from box -> '>'
            // In Three.js ConeGeometry apex is +Y, base is -Y.
            // rotation.x = +Math.PI/2 turns +Y (apex) into +Z (outward!).
            const coneGeo = new THREE.ConeGeometry(2.6, 5.5, 16);
            const cone1 = new THREE.Mesh(coneGeo, handleMat);
            cone1.rotation.x = Math.PI / 2;
            cone1.position.set(0, 0, 5.35);
            handleGroup.add(cone1);

            // Cone 2 points backward along tangent (-Z) away from box -> '<'
            // rotation.x = -Math.PI/2 turns +Y (apex) into -Z (outward!).
            const cone2 = new THREE.Mesh(coneGeo, handleMat);
            cone2.rotation.x = -Math.PI / 2;
            cone2.position.set(0, 0, -5.35);
            handleGroup.add(cone2);

            // Invisible generous hit sphere for easy clicking/dragging on the handle
            const hitSphereGeo = new THREE.SphereGeometry(14, 8, 8);
            const hitMat = new THREE.MeshBasicMaterial({ visible: false });
            const handleHit = new THREE.Mesh(hitSphereGeo, hitMat);
            handleHit.userData = { isCompassHandle: true };
            handleGroup.add(handleHit);

            compassGizmo.add(handleGroup);

            // Invisible hit ring along the entire perimeter so clicking anywhere on the ring allows rotating
            const hitRingGeo = new THREE.RingGeometry(10, 20, 64);
            hitRingGeo.rotateX(-Math.PI / 2);
            const ringHit = new THREE.Mesh(hitRingGeo, hitMat);
            ringHit.userData = { isCompassRing: true };
            compassGizmo.add(ringHit);

            compassGizmo.userData = {
                ringLine,
                ticksLine,
                pointerLine,
                handleGroup,
                handleHit,
                ringHit,
                currentRadius: 50
            };

            scene.add(compassGizmo);
            window._compassGizmo = compassGizmo;
            window._camera = camera;
            window._renderer = renderer;
        }

        window.addEventListener('resize', () => {
            const w2 = viewerWrap.clientWidth, h2 = viewerWrap.clientHeight;
            const aspect2 = w2 / h2;
            if (perspectiveCamera) {
                perspectiveCamera.aspect = aspect2;
                perspectiveCamera.updateProjectionMatrix();
            }
            if (orthographicCamera) {
                orthographicCamera.left = (-frustumSize * aspect2) / 2;
                orthographicCamera.right = (frustumSize * aspect2) / 2;
                orthographicCamera.top = frustumSize / 2;
                orthographicCamera.bottom = -frustumSize / 2;
                orthographicCamera.updateProjectionMatrix();
            }
            renderer.setSize(w2, h2);
        });

    function updateViewCube() {
        if (!viewCubeEl || !camera || !camera.matrixWorldInverse || !camera.matrixWorldInverse.elements) return;
        const e = camera.matrixWorldInverse.elements;
        viewCubeEl.style.transform = `matrix3d(
            ${e[0].toFixed(5)}, ${(-e[1]).toFixed(5)}, ${e[2].toFixed(5)}, 0,
            ${(-e[4]).toFixed(5)}, ${e[5].toFixed(5)}, ${(-e[6]).toFixed(5)}, 0,
            ${e[8].toFixed(5)}, ${(-e[9]).toFixed(5)}, ${e[10].toFixed(5)}, 0,
            0, 0, 0, 1
        )`;
    }

        (function animate(now) {
            requestAnimationFrame(animate);
            PerformanceManager.tick(now); // rolling FPS tracker
            controls.update();
            updateViewCube();
            renderer.render(scene, camera);
        })();
    }

    /**
     * Builds Three.js BufferGeometry from triangles.
     * Centers model horizontally (X & Y) and rests bottom face at Z = 0
     * so it sits perfectly on top of the build plate.
     */
    function buildGeometryFromTriangles(triangles) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            for (const v of [v1, v2, v3]) {
                if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
                if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
                if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
            }
        }

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const centerZ = (minZ + maxZ) / 2; // Centered at 3D geometric center for symmetric rotation

        const positions = new Float32Array(triangles.length * 9);
        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            const offset = i * 9;
            positions[offset]   = v1[0] - centerX; positions[offset+1] = v1[1] - centerY; positions[offset+2] = v1[2] - centerZ;
            positions[offset+3] = v2[0] - centerX; positions[offset+4] = v2[1] - centerY; positions[offset+5] = v2[2] - centerZ;
            positions[offset+6] = v3[0] - centerX; positions[offset+7] = v3[1] - centerY; positions[offset+8] = v3[2] - centerZ;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        return geo;
    }

    function checkPlateFit(bounds) {
        const entry = selectedId ? files.get(selectedId) : null;
        const posX = (entry && entry.mesh) ? entry.mesh.position.x : 0;
        const posZ = (entry && entry.mesh) ? entry.mesh.position.z : 0;
        const half = PLATE_SIZE / 2;
        const minX = -bounds.width / 2 + posX, maxX = bounds.width / 2 + posX;
        const minZ = -bounds.depth / 2 + posZ, maxZ = bounds.depth / 2 + posZ;

        const fits = (minX >= -half && maxX <= half) && (minZ >= -half && maxZ <= half) && (bounds.height <= PLATE_SIZE);
        if (plateFitBadge) {
            if (fits) {
                plateFitBadge.textContent = `Bambu 256×256 mm (Fits)`;
                plateFitBadge.className = 'plate-badge';
            } else {
                plateFitBadge.textContent = `⚠️ Exceeds 256×256 mm!`;
                plateFitBadge.className = 'plate-badge fit-warn';
            }
        }
        return fits;
    }

    function updateMoveInputs(entry) {
        if (!entry || !entry.mesh || !inpPosX) return;
        inpPosX.value = Math.round(entry.mesh.position.x);
        inpPosY.value = Math.round(-entry.mesh.position.z);
        inpPosZ.value = 0;
    }

    function updateScaleInputs(entry) {
        if (!entry || !inpScalePct || !scaleDims) return;
        const s = (entry.mesh ? entry.mesh.scale.x : 1) * 100;
        inpScalePct.value = Math.round(s);
        const b = entry.geometry.bounds;
        scaleDims.textContent = `${b.width.toFixed(1)} × ${b.depth.toFixed(1)} × ${b.height.toFixed(1)} mm`;
    }

    function onGizmoChange() {
        if (currentMode === 'layouts') {
            if (!selectedLayoutMesh || !selectedLayoutMesh.userData) return;
            const p = selectedLayoutMesh.userData.part;
            // Ensure partGroup stays locked flush on the bed surface at Y = 0 (child mesh already offsets by bounds.height/2)
            selectedLayoutMesh.position.y = 0;
            if (p) {
                p.posX = selectedLayoutMesh.position.x;
                p.posZ = selectedLayoutMesh.position.z;
                p.rotY = selectedLayoutMesh.rotation.y;
            }
            if (selectionBox && selectionBox.visible) {
                selectionBox.setFromObject(selectedLayoutMesh);
            }
            checkLayoutPlateCollisions(activePlateIndex);
            return;
        }

        if (!selectedId) return;
        const entry = files.get(selectedId);
        if (!entry || !entry.mesh) return;

        if (currentTool === 'move') {
            entry.mesh.position.y = entry.geometry.bounds.height / 2; // Lock bottom flush on bed
            updateMoveInputs(entry);
            checkPlateFit(entry.geometry.bounds);
        } else if (currentTool === 'scale') {
            const s = entry.mesh.scale.x;
            if (chkUniformScale && chkUniformScale.checked) {
                entry.mesh.scale.y = s;
                entry.mesh.scale.z = s;
            }
            if (inpScalePct) inpScalePct.value = Math.round(s * 100);
            const b = entry.geometry.bounds;
            if (scaleDims) scaleDims.textContent = `${(b.width * s).toFixed(1)} × ${(b.depth * s).toFixed(1)} × ${(b.height * s).toFixed(1)} mm`;
        }

        if (selectionBox && selectionBox.visible && entry.mesh) {
            updateSelectionBoxFast(entry);
        }
    }

    // High-performance O(1) BoxHelper update (0.001ms vs 50ms):
    // Transforms the 8 cached bounding box corners by matrixWorld without traversing 500k vertices!
    function updateSelectionBoxFast(entry) {
        if (!selectionBox || !selectionBox.visible || !entry || !entry.mesh || !entry.mesh.geometry || !entry.mesh.geometry.boundingBox) return;
        entry.mesh.updateMatrixWorld(true);
        _tempBox.copy(entry.mesh.geometry.boundingBox).applyMatrix4(entry.mesh.matrixWorld);
        const e = _tempBox.min, n = _tempBox.max;
        const i = selectionBox.geometry.attributes.position;
        if (!i || !i.array || i.array.length < 24) {
            selectionBox.setFromObject(entry.mesh);
            return;
        }
        const r = i.array;
        r[0]=n.x; r[1]=n.y; r[2]=n.z;
        r[3]=e.x; r[4]=n.y; r[5]=n.z;
        r[6]=e.x; r[7]=e.y; r[8]=n.z;
        r[9]=n.x; r[10]=e.y; r[11]=n.z;
        r[12]=n.x; r[13]=n.y; r[14]=e.z;
        r[15]=e.x; r[16]=n.y; r[17]=e.z;
        r[18]=e.x; r[19]=e.y; r[20]=e.z;
        r[21]=n.x; r[22]=e.y; r[23]=e.z;
        i.needsUpdate = true;
    }

    function onGizmoDragEnd() {
        if (currentMode === 'layouts') {
            if (selectedLayoutMesh && selectedLayoutMesh.userData) {
                selectedLayoutMesh.position.y = 0;
                const p = selectedLayoutMesh.userData.part;
                if (p) {
                    p.posX = selectedLayoutMesh.position.x;
                    p.posZ = selectedLayoutMesh.position.z;
                    p.rotY = selectedLayoutMesh.rotation.y;
                }
                if (selectionBox) selectionBox.setFromObject(selectedLayoutMesh);
                checkLayoutPlateCollisions(activePlateIndex);
            }
            return;
        }

        if (!selectedId) return;
        const entry = files.get(selectedId);
        if (!entry || !entry.mesh) return;

        if (currentTool === 'rotate') {
            bakeMeshTransform(entry, 'Rotated model');
            // Automatic Gravity Fall: if left in a slightly inclined position (<= 25 degrees), settle onto nearest resting face!
            applyGravityFall(entry, { maxAngleDeg: 25, toastPrefix: 'Rotated & settled by gravity' });
        } else if (currentTool === 'scale') {
            bakeMeshTransform(entry, 'Scaled model');
        } else if (currentTool === 'move') {
            checkPlateFit(entry.geometry.bounds);
            if (selectionBox) selectionBox.setFromObject(entry.mesh);
        }
    }

    function bakeMeshTransform(entry, msg) {
        if (!entry || !entry.mesh || !entry.triangles) return;
        if (transformControls) transformControls.detach();

        entry.mesh.updateMatrixWorld(true);
        const matrixWorld = entry.mesh.matrixWorld;
        const posAttr = entry.mesh.geometry.attributes.position;
        const vTmp = new THREE.Vector3();
        const newTriangles = [];

        for (let i = 0; i < entry.triangles.length; i++) {
            const a = i * 3, b = a + 1, c = a + 2;

            vTmp.set(posAttr.getX(a), posAttr.getY(a), posAttr.getZ(a)).applyMatrix4(matrixWorld);
            const v1 = [vTmp.x, -vTmp.z, vTmp.y];

            vTmp.set(posAttr.getX(b), posAttr.getY(b), posAttr.getZ(b)).applyMatrix4(matrixWorld);
            const v2 = [vTmp.x, -vTmp.z, vTmp.y];

            vTmp.set(posAttr.getX(c), posAttr.getY(c), posAttr.getZ(c)).applyMatrix4(matrixWorld);
            const v3 = [vTmp.x, -vTmp.z, vTmp.y];

            newTriangles.push({
                v1, v2, v3,
                storedNormal: [0, 0, 0]
            });
        }

        // Reset mesh transforms to identity
        const initH = entry.geometry.bounds.height;
        entry.mesh.position.set(0, initH / 2, 0);
        entry.mesh.rotation.set(-Math.PI / 2, 0, 0);
        entry.mesh.scale.set(1, 1, 1);
        entry.mesh.updateMatrixWorld(true);

        applyNewTriangles(entry, newTriangles, msg || 'Transform applied');
        if (selectionBox && entry.mesh) selectionBox.setFromObject(entry.mesh);
        if (transformControls && currentTool === 'rotate' && entry.mesh) {
            transformControls.attach(entry.mesh);
            updateGizmoSize(entry);
        }
        updateMoveInputs(entry);
        updateScaleInputs(entry);
    }

    function setTransformTool(toolName) {
        if (currentTool === toolName && toolName !== 'view') {
            toolName = 'view';
        }
        currentTool = toolName;

        const toolBtns = [
            { id: 'tool-rotate', name: 'rotate' },
            { id: 'tool-lay-face', name: 'lay-face' }
        ];
        toolBtns.forEach(t => {
            const btn = document.getElementById(t.id);
            if (btn) {
                if (t.name === toolName) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });

        // Hide all inspector panels
        if (bambuInspector) bambuInspector.classList.add('hidden');
        const pRot = document.getElementById('panel-rotate');
        if (pRot) pRot.style.display = 'none';

        if (toolName !== 'lay-face') {
            deactivatePickMode();
        }

        const entry = selectedId ? files.get(selectedId) : null;
        if (!entry || !entry.mesh) {
            if (transformControls) transformControls.detach();
            if (selectionBox) selectionBox.visible = false;
            return;
        }

        if (toolName === 'view') {
            if (transformControls) transformControls.detach();
            if (selectionBox) selectionBox.visible = false;
        } else if (toolName === 'rotate') {
            if (transformControls) {
                transformControls.setMode('rotate');
                transformControls.setSpace('local');
                transformControls.attach(entry.mesh);
                updateGizmoSize(entry);
                transformControls.showX = true;
                transformControls.showY = true;
                transformControls.showZ = true;
            }
            if (selectionBox) {
                selectionBox.setFromObject(entry.mesh);
                selectionBox.visible = true;
            }
            if (bambuInspector) {
                bambuInspector.classList.remove('hidden');
                const p = document.getElementById('panel-rotate');
                if (p) p.style.display = 'block';
            }
        } else if (toolName === 'lay-face') {
            if (transformControls) transformControls.detach();
            if (selectionBox) {
                selectionBox.setFromObject(entry.mesh);
                selectionBox.visible = true;
            }
            activatePickMode();
        }
    }

    function updateGizmoSize(entry) {
        if (!transformControls || !entry || !entry.geometry) return;
        const b = entry.geometry.bounds;
        // Bounding box half-diagonal (distance from 3D center to any corner of the box)
        const halfDiag = Math.hypot(b.width, b.depth, b.height) / 2;
        // The rotation rings must completely engulf the viewcube / bounding box:
        // Give 15% safety margin beyond the farthest corner so the box is fully inside
        const worldRadius = Math.max(15, halfDiag * 1.15);
        transformControls.worldRadius = worldRadius;
        transformControls.size = 1.0;
    }

    // ── Multi-mesh scene helpers ──────────────────────────────────────────────

    // Returns the merged world-space bounding box of every loaded mesh.
    function getAllMeshesBoundingBox() {
        const box = new THREE.Box3();
        let any = false;
        files.forEach(f => {
            if (f.mesh && f.mesh.visible) {
                box.expandByObject(f.mesh);
                any = true;
            }
        });
        return any ? box : null;
    }

    // Ensure strictly ONLY the active entry is visible in the Objects view.
    // All other loaded files in Objects mode are completely hidden (no ghosting, no multi-model overlap).
    function syncAllMeshVisibility(activeEntry) {
        if (!scene) return;
        files.forEach(entry => {
            const isSelected = !!(activeEntry && entry.id === activeEntry.id);
            if (!isSelected) {
                if (entry.mesh) {
                    entry.mesh.visible = false;
                }
                return;
            }

            // Build active entry mesh if not yet created
            if (!entry.mesh) {
                const geo = buildGeometryFromTriangles(entry.triangles);
                const mat = new THREE.MeshStandardMaterial({
                    roughness: 0.55,
                    metalness: 0.05,
                    side: THREE.DoubleSide
                });
                entry.mesh = new THREE.Mesh(geo, mat);
                entry.mesh.rotation.x = -Math.PI / 2;
                entry.mesh.position.set(0, entry.geometry.bounds.height / 2, 0);
                scene.add(entry.mesh);
            }

            entry.mesh.visible = true;
            entry.mesh.material.color.set(entry.config.color);
            entry.mesh.material.transparent = false;
            entry.mesh.material.opacity = 1.0;
            entry.mesh.material.depthWrite = true;
            entry.mesh.renderOrder = 0;
        });
    }

    // Fit camera to bounding box of all visible meshes.
    function fitCameraToAllMeshes() {
        const box = getAllMeshesBoundingBox();
        if (!box || box.isEmpty()) { viewHome(); return; }
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 60); // min 60mm
        if (camera.isOrthographicCamera) {
            camera.zoom = frustumSize / (maxDim * 1.45);
            camera.updateProjectionMatrix();
            const dist = 350;
            camera.position.set(center.x + dist * 0.6, dist * 0.7, center.z + dist * 0.6);
        } else {
            const fov    = (camera.fov || 45) * (Math.PI / 180);
            const dist   = (maxDim / 2) / Math.tan(fov / 2) * 1.6;
            camera.position.set(center.x + dist * 0.6, dist * 0.7, center.z + dist * 0.6);
        }
        controls.target.copy(center);
        controls.update();
    }

    function showMeshForFile(entry) {
        if (!scene) initViewer();
        if (viewerEmpty) viewerEmpty.style.display = 'none';
        if (!entry) return;

        if (layoutPlateGroup) layoutPlateGroup.visible = false;

        // In Objects mode: only show this individual object on the bed!
        files.forEach(f => {
            if (f.mesh) f.mesh.visible = (f.id === entry.id);
        });

        // Ensure this entry's mesh exists and is positioned correctly
        if (!entry.mesh) {
            const geo = buildGeometryFromTriangles(entry.triangles);
            const mat = new THREE.MeshStandardMaterial({
                roughness: 0.55,
                metalness: 0.05,
                side: THREE.DoubleSide
            });
            entry.mesh = new THREE.Mesh(geo, mat);
            entry.mesh.rotation.x = -Math.PI / 2;
            scene.add(entry.mesh);
        }

        // Center the individual object on the build plate
        entry.mesh.position.set(0, entry.geometry.bounds.height / 2, 0);
        entry.mesh.material.color.set(entry.config.color);
        entry.mesh.material.transparent = false;
        entry.mesh.material.opacity = 1.0;
        entry.mesh.visible = true;

        // Selection box on active mesh only
        if (selectionBox) {
            selectionBox.setFromObject(entry.mesh);
            selectionBox.visible = (currentTool !== 'view');
        }

        checkPlateFit(entry.geometry.bounds);
        updateMoveInputs(entry);
        updateScaleInputs(entry);
        updateGizmoSize(entry);

        if (currentTool !== 'view' && currentTool !== 'lay-face' && transformControls) {
            transformControls.attach(entry.mesh);
        }

        controls.target.set(0, 0, 0);
        viewHome();
    }

    function zoomFit() {
        fitCameraToAllMeshes();
    }

    // ── Orientation & Bed Facing Handlers ────────────────────────────────────
    function applyNewTriangles(entry, newTriangles, msg) {
        deactivatePickMode();
        if (transformControls) transformControls.detach();
        entry.triangles = newTriangles;
        entry.adjacency = null; // Rebuild mesh adjacency on demand for new orientation
        entry.geometry  = STLParser.calculateGeometry(entry.triangles);
        entry.geometry.triangles = entry.triangles;

        if (entry.mesh) {
            // Clean up any child helpers attached to entry.mesh to prevent ghosting
            while (entry.mesh.children.length > 0) {
                const child = entry.mesh.children[0];
                entry.mesh.remove(child);
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            }
            entry.mesh.geometry.dispose();
            entry.mesh.geometry = buildGeometryFromTriangles(entry.triangles);
            entry.mesh.rotation.set(-Math.PI / 2, 0, 0);
            entry.mesh.position.set(entry.mesh.position.x, entry.geometry.bounds.height / 2, entry.mesh.position.z);
            entry.mesh.updateMatrixWorld(true);
        }

        // Re-sync active/dim state across all meshes
        const activeEntry = selectedId ? files.get(selectedId) : null;
        syncAllMeshVisibility(activeEntry || entry);

        updateGizmoSize(entry);
        if (selectionBox && entry.mesh) {
            selectionBox.setFromObject(entry.mesh);
            selectionBox.visible = (currentTool !== 'view');
        }
        if (transformControls && currentTool === 'rotate' && entry.mesh) {
            transformControls.attach(entry.mesh);
            updateGizmoSize(entry);
        }
        entry.estimates = PrintEstimator.estimate(entry.geometry, entry.config);
        checkPlateFit(entry.geometry.bounds);
        ThumbnailRenderer.captureModel(entry);
        renderFileList();
        updateDetails(entry);
        if (msg) showToast(msg, 'success');
    }

    function rotateSelected(axis, angleDeg) {
        if (!selectedId) return;
        const entry = files.get(selectedId);
        if (!entry || !entry.triangles) return;

        const rotated = STLParser.rotateTriangles(entry.triangles, axis, angleDeg);
        if (sBedFacing) sBedFacing.value = 'custom';
        applyNewTriangles(entry, rotated, `Rotated ${angleDeg}° on ${axis.toUpperCase()}`);
    }

    function snapBedFace(face) {
        if (!selectedId) return;
        const entry = files.get(selectedId);
        if (!entry || !entry.originalTriangles) return;

        // Reset to original triangles and apply exact face transform
        let rotated = entry.originalTriangles;
        if (face === 'bottom') {
            // Default upright orientation
            rotated = entry.originalTriangles;
        } else if (face === 'top') {
            // Flip 180° so top faces the bed
            rotated = STLParser.rotateTriangles(rotated, 'x', 180);
        } else if (face === 'front') {
            // Front face down
            rotated = STLParser.rotateTriangles(rotated, 'x', -90);
        } else if (face === 'back') {
            // Back face down
            rotated = STLParser.rotateTriangles(rotated, 'x', 90);
        } else if (face === 'left') {
            // Left face down
            rotated = STLParser.rotateTriangles(rotated, 'y', 90);
        } else if (face === 'right') {
            // Right face down
            rotated = STLParser.rotateTriangles(rotated, 'y', -90);
        }
        entry.bedFacing = face;
        applyNewTriangles(entry, rotated, `Snapped ${face.toUpperCase()} face to build bed`);
    }

    // ── Advanced Auto-Orient & Click-Face-To-Bed ─────────────────────────────
    let isPickingFace = false;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // 1. Precompute vertex-to-triangle adjacency for instantaneous coplanar flood-fill
    function buildMeshAdjacency(triangles) {
        // Quantize coordinates to 0.1 mm precision to connect shared vertices accurately
        const vKey = (x, y, z) => `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(z * 10)}`;
        const vertToTris = new Map();
        const triNormals = new Float32Array(triangles.length * 3);

        for (let i = 0; i < triangles.length; i++) {
            const t = triangles[i];
            const v1 = t.v1, v2 = t.v2, v3 = t.v3;

            // Compute unit normal from triangle vertices
            const ax = v2[0] - v1[0], ay = v2[1] - v1[1], az = v2[2] - v1[2];
            const bx = v3[0] - v1[0], by = v3[1] - v1[1], bz = v3[2] - v1[2];
            let nx = ay * bz - az * by;
            let ny = az * bx - ax * bz;
            let nz = ax * by - ay * bx;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 1e-7) {
                nx /= len; ny /= len; nz /= len;
            } else {
                nx = 0; ny = 0; nz = 1;
            }
            triNormals[i * 3]     = nx;
            triNormals[i * 3 + 1] = ny;
            triNormals[i * 3 + 2] = nz;

            // Index the 3 vertices
            for (const v of [v1, v2, v3]) {
                const k = vKey(v[0], v[1], v[2]);
                let list = vertToTris.get(k);
                if (!list) {
                    list = [];
                    vertToTris.set(k, list);
                }
                list.push(i);
            }
        }

        return { vertToTris, triNormals, vKey };
    }

    // Finds all tangentially connected / coplanar triangles from a seed face
    function getConnectedCoplanarTriangles(entry, startIdx, maxCount = 2500) {
        if (!entry.adjacency) {
            entry.adjacency = buildMeshAdjacency(entry.triangles);
        }
        const { vertToTris, triNormals, vKey } = entry.adjacency;
        const triangles = entry.triangles;
        if (startIdx < 0 || startIdx >= triangles.length) return [startIdx];

        const seedNx = triNormals[startIdx * 3];
        const seedNy = triNormals[startIdx * 3 + 1];
        const seedNz = triNormals[startIdx * 3 + 2];
        const seedV = triangles[startIdx].v1;
        const seedD = seedNx * seedV[0] + seedNy * seedV[1] + seedNz * seedV[2];

        // Pass 1: Strict coplanar search (angle >= 0.985 ≈ 10°, plane offset diff < 0.35 mm)
        const visited = new Set([startIdx]);
        const queue = [startIdx];
        const result = [startIdx];

        while (queue.length > 0 && result.length < maxCount) {
            const currIdx = queue.shift();
            const currTri = triangles[currIdx];

            for (const v of [currTri.v1, currTri.v2, currTri.v3]) {
                const k = vKey(v[0], v[1], v[2]);
                const neighbors = vertToTris.get(k);
                if (!neighbors) continue;

                for (let j = 0; j < neighbors.length; j++) {
                    const nIdx = neighbors[j];
                    if (visited.has(nIdx)) continue;
                    visited.add(nIdx);

                    const nx = triNormals[nIdx * 3];
                    const ny = triNormals[nIdx * 3 + 1];
                    const nz = triNormals[nIdx * 3 + 2];

                    const dot = seedNx * nx + seedNy * ny + seedNz * nz;
                    if (dot >= 0.985) {
                        const nV = triangles[nIdx].v1;
                        const d = nx * nV[0] + ny * nV[1] + nz * nV[2];
                        if (Math.abs(d - seedD) < 0.35) {
                            result.push(nIdx);
                            queue.push(nIdx);
                            if (result.length >= maxCount) break;
                        }
                    }
                }
                if (result.length >= maxCount) break;
            }
        }

        // Pass 2 Fallback: If only 1-2 triangles found (curved fillet, chamfer, or small faceted loop),
        // expand tangentially across connected neighbors without plane offset constraint
        if (result.length <= 2) {
            visited.clear();
            visited.add(startIdx);
            queue.length = 0;
            queue.push(startIdx);
            result.length = 0;
            result.push(startIdx);

            while (queue.length > 0 && result.length < maxCount) {
                const currIdx = queue.shift();
                const currTri = triangles[currIdx];

                for (const v of [currTri.v1, currTri.v2, currTri.v3]) {
                    const k = vKey(v[0], v[1], v[2]);
                    const neighbors = vertToTris.get(k);
                    if (!neighbors) continue;

                    for (let j = 0; j < neighbors.length; j++) {
                        const nIdx = neighbors[j];
                        if (visited.has(nIdx)) continue;
                        visited.add(nIdx);

                        const nx = triNormals[nIdx * 3];
                        const ny = triNormals[nIdx * 3 + 1];
                        const nz = triNormals[nIdx * 3 + 2];

                        const dot = seedNx * nx + seedNy * ny + seedNz * nz;
                        if (dot >= 0.95) { // ~18° tangential slope
                            result.push(nIdx);
                            queue.push(nIdx);
                            if (result.length >= maxCount) break;
                        }
                    }
                    if (result.length >= maxCount) break;
                }
            }
        }

        return result;
    }

    // 2. High-visibility Tangential Guide Plane (rect planar preview with grid & normal indicator)
    function createTangentGuide() {
        const group = new THREE.Group();
        group.name = 'tangentGuide';

        // Semi-transparent golden plane
        const planeGeo = new THREE.PlaneGeometry(50, 50);
        const planeMat = new THREE.MeshBasicMaterial({
            color: 0xffd166,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const planeMesh = new THREE.Mesh(planeGeo, planeMat);
        group.add(planeMesh);

        // Crisp glowing outer perimeter
        const borderGeo = new THREE.EdgesGeometry(planeGeo);
        const borderMat = new THREE.LineBasicMaterial({
            color: 0xffe899,
            linewidth: 2,
            transparent: true,
            opacity: 0.95
        });
        const border = new THREE.LineSegments(borderGeo, borderMat);
        group.add(border);

        // Grid lines to clearly reveal 3D slant and perspective
        const gridInner = new THREE.GridHelper(50, 4, 0xffd166, 0xffe899);
        gridInner.rotation.x = Math.PI / 2;
        gridInner.material.transparent = true;
        gridInner.material.opacity = 0.55;
        group.add(gridInner);

        // Center Crosshair
        const crossGeo = new THREE.BufferGeometry();
        crossGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            -16, 0, 0,  16, 0, 0,
            0, -16, 0,  0, 16, 0
        ]), 3));
        const cross = new THREE.LineSegments(crossGeo, new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9
        }));
        group.add(cross);

        // Normal direction arrow pointing outward from surface
        const arrowHelper = new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(0, 0, 0),
            22,
            0xffe28a,
            6,
            4
        );
        group.add(arrowHelper);

        group.visible = false;
        group.renderOrder = 1000;
        return group;
    }

    // Dynamic Multi-Triangle Hover Highlight Overlay Mesh
    const MAX_HIGHLIGHT_TRIS = 3000;
    const hoverFacePositions = new Float32Array(MAX_HIGHLIGHT_TRIS * 9);
    const hoverFaceGeo = new THREE.BufferGeometry();
    hoverFaceGeo.setAttribute('position', new THREE.BufferAttribute(hoverFacePositions, 3));
    const hoverFaceMat = new THREE.MeshBasicMaterial({
        color: 0xffd166, // Warm bright gold highlight
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthTest: false
    });
    const hoverFaceMesh = new THREE.Mesh(hoverFaceGeo, hoverFaceMat);
    hoverFaceMesh.visible = false;
    hoverFaceMesh.renderOrder = 999;
    const tangentGuide = createTangentGuide();

    // ── Mesh Center of Mass (3D Volumetric Centroid) ─────────────────────────
    function calculateMeshCenterOfMass(triangles) {
        let totalVol = 0;
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            const v6 = v1[0] * (v2[1] * v3[2] - v3[1] * v2[2])
                     - v2[0] * (v1[1] * v3[2] - v3[1] * v1[2])
                     + v3[0] * (v1[1] * v2[2] - v2[1] * v1[2]);
            const tetVol = v6 / 6.0;
            totalVol += tetVol;
            cx += tetVol * (v1[0] + v2[0] + v3[0]) * 0.25;
            cy += tetVol * (v1[1] + v2[1] + v3[1]) * 0.25;
            cz += tetVol * (v1[2] + v2[2] + v3[2]) * 0.25;
        }
        if (Math.abs(totalVol) < 1e-5) {
            let sx = 0, sy = 0, sz = 0, count = 0;
            for (let i = 0; i < triangles.length; i++) {
                const { v1, v2, v3 } = triangles[i];
                sx += v1[0] + v2[0] + v3[0];
                sy += v1[1] + v2[1] + v3[1];
                sz += v1[2] + v2[2] + v3[2];
                count += 3;
            }
            return { x: sx / Math.max(1, count), y: sy / Math.max(1, count), z: sz / Math.max(1, count), volume: 0 };
        }
        return {
            x: cx / totalVol,
            y: cy / totalVol,
            z: cz / totalVol,
            volume: Math.abs(totalVol)
        };
    }

    // ── 2D Convex Hull (Monotone Chain) ──────────────────────────────────────
    function compute2DConvexHull(points) {
        if (points.length <= 2) return points.slice();
        const pts = points.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

        const lower = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                lower.pop();
            }
            lower.push(p);
        }

        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            const p = pts[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                upper.pop();
            }
            upper.push(p);
        }

        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    // ── Check if point (px, py) is inside 2D convex polygon with safety margin
    function isPointInConvexPolygon(polygon, px, py, margin = 0.5) {
        if (!polygon || polygon.length < 3) return false;
        const n = polygon.length;
        let sign = 0;

        for (let i = 0; i < n; i++) {
            const [x1, y1] = polygon[i];
            const [x2, y2] = polygon[(i + 1) % n];
            const dx = x2 - x1, dy = y2 - y1;
            const cross = dx * (py - y1) - dy * (px - x1);
            const edgeLen = Math.hypot(dx, dy);
            const dist = edgeLen > 1e-6 ? cross / edgeLen : 0;

            if (dist < -margin) return false;

            if (cross > 0) {
                if (sign < 0) return false;
                sign = 1;
            } else if (cross < 0) {
                if (sign > 0) return false;
                sign = -1;
            }
        }
        return true;
    }

    // ── Extract genuine planar regions from triangles (exact normals & boundary points)
    // Uses high-speed O(1) spatial hash bucketing for zero freeze even on 500k triangle meshes
    function extractPlanarRegions(triangles) {
        if (!triangles || triangles.length === 0) return [];

        if (!triangles || triangles.length === 0) return [];

        const triData = [];
        let totalArea = 0;

        for (let i = 0; i < triangles.length; i++) {
            const t = triangles[i];
            const e1x = t.v2[0] - t.v1[0], e1y = t.v2[1] - t.v1[1], e1z = t.v2[2] - t.v1[2];
            const e2x = t.v3[0] - t.v1[0], e2y = t.v3[1] - t.v1[1], e2z = t.v3[2] - t.v1[2];

            let cx = e1y * e2z - e1z * e2y;
            let cy = e1z * e2x - e1x * e2z;
            let cz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(cx, cy, cz);
            if (len < 1e-8) continue;

            const area = 0.5 * len;
            totalArea += area;

            let nx = cx / len, ny = cy / len, nz = cz / len;
            if (t.storedNormal) {
                const sn = t.storedNormal;
                if (sn[0]*nx + sn[1]*ny + sn[2]*nz < -0.5) {
                    nx = -nx; ny = -ny; nz = -nz;
                }
            }
            const d = nx * t.v1[0] + ny * t.v1[1] + nz * t.v1[2];
            triData.push({ v1: t.v1, v2: t.v2, v3: t.v3, nx, ny, nz, d, area });
        }

        // Quantize normal into ~9° bins for fast O(N) spatial hashing
        const BINS_N = 20;
        const bucketMap = new Map();
        for (let i = 0; i < triData.length; i++) {
            const td = triData[i];
            const qx = Math.round(td.nx * BINS_N);
            const qy = Math.round(td.ny * BINS_N);
            const qz = Math.round(td.nz * BINS_N);
            const key = `${qx}_${qy}_${qz}`;
            let list = bucketMap.get(key);
            if (!list) {
                list = [];
                bucketMap.set(key, list);
            }
            list.push(td);
        }

        const clusters = [];
        const minClusterArea = Math.max(12.0, totalArea * 0.0008);

        for (const [key, list] of bucketMap.entries()) {
            list.sort((a, b) => a.d - b.d);
            const sub = [];
            for (const td of list) {
                let placed = false;
                for (const sc of sub) {
                    const dot = sc.nx * td.nx + sc.ny * td.ny + sc.nz * td.nz;
                    if (dot > 0.996 && Math.abs(sc.d - td.d) < 0.6) {
                        const newArea = sc.area + td.area;
                        sc.nx = (sc.nx * sc.area + td.nx * td.area) / newArea;
                        sc.ny = (sc.ny * sc.area + td.ny * td.area) / newArea;
                        sc.nz = (sc.nz * sc.area + td.nz * td.area) / newArea;
                        const nLen = Math.hypot(sc.nx, sc.ny, sc.nz);
                        sc.nx /= nLen; sc.ny /= nLen; sc.nz /= nLen;
                        sc.d = (sc.d * sc.area + td.d * td.area) / newArea;
                        sc.area = newArea;
                        sc.tris.push(td);
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    sub.push({ nx: td.nx, ny: td.ny, nz: td.nz, d: td.d, area: td.area, tris: [td] });
                }
            }
            for (const sc of sub) {
                // Keep sub-clusters with area >= 1.0 so circular/beveled rims split across angular hash buckets can merge
                if (sc.area >= 1.0) clusters.push(sc);
            }
        }

        // Cross-bucket merging to unify facets that span across hash boundaries
        const merged = [];
        clusters.sort((a, b) => b.area - a.area);
        for (const c of clusters) {
            let joined = false;
            for (const m of merged) {
                const dot = m.nx * c.nx + m.ny * c.ny + m.nz * c.nz;
                if (dot > 0.993 && Math.abs(m.d - c.d) < 1.0) {
                    const newArea = m.area + c.area;
                    m.nx = (m.nx * m.area + c.nx * c.area) / newArea;
                    m.ny = (m.ny * m.area + c.ny * c.area) / newArea;
                    m.nz = (m.nz * m.area + c.nz * c.area) / newArea;
                    const nLen = Math.hypot(m.nx, m.ny, m.nz);
                    m.nx /= nLen; m.ny /= nLen; m.nz /= nLen;
                    m.d = (m.d * m.area + c.d * c.area) / newArea;
                    m.area = newArea;
                    m.tris.push(...c.tris);
                    joined = true;
                    break;
                }
            }
            if (!joined) merged.push(c);
        }

        // Cardinal axis snap: if within 2.5 degrees of any cardinal axis, snap to exact axis!
        const axes = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];

        const validMerged = merged.filter(m => m.area >= minClusterArea);
        const validPlanar = [];
        for (const m of validMerged) {
            let avgNx = m.nx, avgNy = m.ny, avgNz = m.nz;
            for (const [ax, ay, az] of axes) {
                if (avgNx * ax + avgNy * ay + avgNz * az > 0.9990) { // ~2.5 degrees
                    avgNx = ax; avgNy = ay; avgNz = az;
                    break;
                }
            }
            const norm = new THREE.Vector3(avgNx, avgNy, avgNz);

            // Collect points from all triangles in the facet
            const pts = [];
            for (const t of m.tris) {
                pts.push(
                    new THREE.Vector3(t.v1[0], t.v1[1], t.v1[2]),
                    new THREE.Vector3(t.v2[0], t.v2[1], t.v2[2]),
                    new THREE.Vector3(t.v3[0], t.v3[1], t.v3[2])
                );
            }

            // Check 2D spread to filter out 1D chord strips along curved cylinder/flute walls
            const up = Math.abs(norm.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
            const uAxis = new THREE.Vector3().crossVectors(norm, up).normalize();
            const vAxis = new THREE.Vector3().crossVectors(norm, uAxis).normalize();

            let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
            for (const pt of pts) {
                const u = pt.dot(uAxis);
                const v = pt.dot(vAxis);
                if (u < minU) minU = u; if (u > maxU) maxU = u;
                if (v < minV) minV = v; if (v > maxV) maxV = v;
            }
            const width = maxU - minU;
            const height = maxV - minV;
            const minDim = Math.min(width, height);
            const maxDim = Math.max(width, height);

            // Filter out 1D chord strips on curved walls (e.g. spiral vase flutes)
            if (minDim < 2.0 && maxDim > 10.0) {
                continue;
            }

            // Keep up to 250 well-distributed sample points for fast 2D hull computation
            let finalPts = pts;
            if (pts.length > 250) {
                const step = Math.ceil(pts.length / 250);
                finalPts = [];
                for (let k = 0; k < pts.length; k += step) {
                    finalPts.push(pts[k]);
                }
            }

            validPlanar.push({
                normal: norm,
                d: m.d,
                area: m.area,
                points: finalPts,
                isMeshFacet: true
            });
        }

        validPlanar.sort((a, b) => b.area - a.area);
        return validPlanar;
    }

    // ── Extract prominent planar facet normals (excludes curved micro-facets)
    function getMajorPlanarNormals(triangles, maxNormals = 12) {
        const planar = extractPlanarRegions(triangles);
        return planar.slice(0, maxNormals).map(c => [c.normal.x, c.normal.y, c.normal.z]);
    }

    // ── Fast candidate evaluator with Gravity Fall Stability & Adhesion
    function evaluateOrientationCandidate(triangles) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            for (const v of [v1, v2, v3]) {
                if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
                if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
                if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
            }
        }

        const height = maxZ - minZ;
        const bedZThreshold = minZ + 0.40; // 0.4mm bottom contact tolerance
        const com = calculateMeshCenterOfMass(triangles);

        let overhangArea = 0;
        let supportVolume = 0;
        let bedContactArea = 0;
        const contactPoints = [];

        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            const e1x = v2[0] - v1[0], e1y = v2[1] - v1[1], e1z = v2[2] - v1[2];
            const e2x = v3[0] - v1[0], e2y = v3[1] - v1[1], e2z = v3[2] - v1[2];

            const cx = e1y * e2z - e1z * e2y;
            const cy = e1z * e2x - e1x * e2z;
            const cz = e1x * e2y - e1y * e2x;
            const cLen = Math.hypot(cx, cy, cz);
            if (cLen < 1e-8) continue;

            const triArea = 0.5 * cLen;
            const nzNorm = cz / cLen;
            const zCenter = (v1[2] + v2[2] + v3[2]) / 3.0;

            // Overhang: downward facing > 45° from vertical and above bed
            if (nzNorm < -0.707 && zCenter > minZ + 1.0) {
                overhangArea += triArea;
                supportVolume += (triArea * Math.abs(nzNorm)) * (zCenter - minZ);
            }

            // Bed contact: flat bottom touching the build plate
            if (v1[2] <= bedZThreshold && v2[2] <= bedZThreshold && v3[2] <= bedZThreshold && nzNorm < -0.85) {
                bedContactArea += triArea;
                contactPoints.push([v1[0], v1[1]], [v2[0], v2[1]], [v3[0], v3[1]]);
            } else {
                if (v1[2] <= bedZThreshold) contactPoints.push([v1[0], v1[1]]);
                if (v2[2] <= bedZThreshold) contactPoints.push([v2[0], v2[1]]);
                if (v3[2] <= bedZThreshold) contactPoints.push([v3[0], v3[1]]);
            }
        }

        // Gravity stability check: Center of mass projection must fall within contact hull
        let isStable = false;
        let stabilityPenalty = 0;
        let adhesionPenalty = 0;

        if (contactPoints.length >= 3 && bedContactArea > 10.0) {
            const hull = compute2DConvexHull(contactPoints);
            if (hull.length >= 3) {
                isStable = isPointInConvexPolygon(hull, com.x, com.y, 1.5);
            }
        }

        if (!isStable) {
            // Heavily penalize unstable orientations that would topple or balance on an edge
            stabilityPenalty = 250000;
        }

        // Adhesion penalty: heavily penalize orientations that touch the bed with negligible surface area (< 25 mm²)
        // A model cannot be printed balancing on a sharp tip or edge
        if (bedContactArea < 25.0) {
            adhesionPenalty = 200000;
        }

        // Bambu Studio Balanced Objective Function:
        // Priority 1: Solid bed adhesion (flat base on bed)
        // Priority 2: Physical gravity balance
        // Priority 3: Minimize overhangs and support material
        const score = (overhangArea * 2.5)
                    + (supportVolume * 0.02)
                    - (bedContactArea * 120.0)
                    + (height * 0.3)
                    + stabilityPenalty
                    + adhesionPenalty;

        return { score, isStable, overhangArea, bedContactArea, height };
    }

    // Ensure bottom contact planar face is leveled 100% parallel to bed (Z = 0) with zero tilt/gap
    function levelMeshBedContact(triangles) {
        if (!triangles || triangles.length === 0) return triangles;
        let minZ = Infinity;
        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            if (v1[2] < minZ) minZ = v1[2];
            if (v2[2] < minZ) minZ = v2[2];
            if (v3[2] < minZ) minZ = v3[2];
        }
        const bedTol = minZ + 0.60;
        let nSumX = 0, nSumY = 0, nSumZ = 0, areaSum = 0;
        for (let i = 0; i < triangles.length; i++) {
            const t = triangles[i];
            if (t.v1[2] <= bedTol && t.v2[2] <= bedTol && t.v3[2] <= bedTol) {
                const e1x = t.v2[0] - t.v1[0], e1y = t.v2[1] - t.v1[1], e1z = t.v2[2] - t.v1[2];
                const e2x = t.v3[0] - t.v1[0], e2y = t.v3[1] - t.v1[1], e2z = t.v3[2] - t.v1[2];
                const cx = e1y * e2z - e1z * e2y;
                const cy = e1z * e2x - e1x * e2z;
                const cz = e1x * e2y - e1y * e2x;
                const len = Math.hypot(cx, cy, cz);
                if (len > 1e-8) {
                    const a = 0.5 * len;
                    let nx = cx / len, ny = cy / len, nz = cz / len;
                    if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }
                    if (nz < -0.90) {
                        nSumX += nx * a;
                        nSumY += ny * a;
                        nSumZ += nz * a;
                        areaSum += a;
                    }
                }
            }
        }

        if (areaSum > 15.0) {
            const nLen = Math.hypot(nSumX, nSumY, nSumZ);
            if (nLen > 1e-6) {
                const avgNx = nSumX / nLen;
                const avgNy = nSumY / nLen;
                const avgNz = nSumZ / nLen;
                // If slightly tilted (up to 5 degrees) from exact [0, 0, -1], rotate flush!
                const dot = -avgNz;
                if (dot > 0.996 && dot < 0.999999) {
                    return STLParser.rotateTrianglesToNormal(triangles, [avgNx, avgNy, avgNz]);
                }
            }
        }
        return triangles;
    }

    function autoOrient() {
        if (!selectedId) {
            showToast('Select a 3D model first', 'warn');
            return;
        }
        const entry = files.get(selectedId);
        if (!entry || !entry.triangles) return;
        deactivatePickMode();

        // 1. Build list of candidate orientations:
        // All 24 orthogonal orientations
        const orthogonalRotations = [
            [],
            [['x', 90]], [['x', 180]], [['x', 270]],
            [['y', 90]], [['y', 180]], [['y', 270]],
            [['z', 90]], [['z', 180]], [['z', 270]],
            [['x', 90], ['y', 90]], [['x', 90], ['y', 180]], [['x', 90], ['y', 270]],
            [['x', 180], ['y', 90]], [['x', 180], ['y', 270]],
            [['x', 270], ['y', 90]], [['x', 270], ['y', 180]], [['x', 270], ['y', 270]],
            [['y', 90], ['z', 90]], [['y', 90], ['z', 270]],
            [['y', 270], ['z', 90]], [['y', 270], ['z', 270]],
            [['x', 90], ['z', 90]], [['x', 90], ['z', 270]]
        ];

        const candidateDefs = [];
        for (const seq of orthogonalRotations) {
            candidateDefs.push({ type: 'ortho', seq });
        }

        // 2. Major planar facet normals (e.g. cut flat base or chamfered faces)
        const majorNormals = getMajorPlanarNormals(entry.triangles, 8);
        for (const norm of majorNormals) {
            candidateDefs.push({ type: 'normal', norm });
        }

        // 3. Exterior hull normals (skip any that duplicate a major planar normal)
        if (window.THREE && THREE.ConvexHull && entry.mesh) {
            try {
                const posAttr = entry.mesh.geometry.attributes.position;
                const totalVerts = posAttr.count;
                const step = Math.max(1, Math.floor(totalVerts / 350));
                const samplePoints = [];
                for (let i = 0; i < totalVerts; i += step) {
                    samplePoints.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
                }
                const hull = new THREE.ConvexHull();
                hull.setFromPoints(samplePoints);
                const hullNormals = [];
                hull.faces.forEach(f => {
                    const n = f.normal;
                    if (!hullNormals.some(ex => ex.dot(n) > 0.95)) {
                        hullNormals.push(n);
                    }
                });
                for (const hn of hullNormals) {
                    const isCloseToPlanar = majorNormals.some(mn => (mn[0]*hn.x + mn[1]*hn.y + mn[2]*hn.z) > 0.96);
                    if (!isCloseToPlanar) {
                        candidateDefs.push({ type: 'normal', norm: [hn.x, hn.y, hn.z] });
                    }
                }
            } catch (e) {}
        }

        const total = candidateDefs.length;
        let bestTriangles = entry.triangles;
        let bestScore = Infinity;
        let currentIndex = 0;

        // Open sleek Bambu progress modal
        if (progressModal) {
            progressModal.classList.remove('hidden');
            if (progressBarFill) progressBarFill.style.width = '0%';
            if (progressPct) progressPct.textContent = '0%';
            if (progressStatus) progressStatus.textContent = 'Analyzing candidate orientations & bed stability...';
            if (progressDetail) progressDetail.textContent = `0 of ${total} orientations evaluated`;
        }

        // Run non-blocking chunked evaluation across frames (generates candidate on demand to save 90% memory)
        function processChunk() {
            const CHUNK_SIZE = 2; // Process 2 orientations per frame so browser never hangs
            const limit = Math.min(currentIndex + CHUNK_SIZE, total);

            for (; currentIndex < limit; currentIndex++) {
                const def = candidateDefs[currentIndex];
                let candidate;
                if (def.type === 'ortho') {
                    let t = entry.triangles;
                    for (const [ax, deg] of def.seq) {
                        t = STLParser.rotateTriangles(t, ax, deg);
                    }
                    candidate = t;
                } else {
                    candidate = STLParser.rotateTrianglesToNormal(entry.triangles, def.norm);
                }

                const res = evaluateOrientationCandidate(candidate);
                if (res.score < bestScore) {
                    bestScore = res.score;
                    bestTriangles = candidate;
                }
            }

            const pct = Math.round((currentIndex / total) * 100);
            if (progressBarFill) progressBarFill.style.width = `${pct}%`;
            if (progressPct) progressPct.textContent = `${pct}%`;
            if (progressDetail) progressDetail.textContent = `${currentIndex} of ${total} orientations evaluated`;
            if (progressStatus) {
                progressStatus.textContent = currentIndex < total
                    ? `Simulating gravity balance & bed adhesion (${pct}%)...`
                    : 'Finalizing optimal orientation...';
            }

            if (currentIndex < total) {
                setTimeout(processChunk, 0); // Yield to browser paint
            } else {
                setTimeout(() => {
                    if (progressModal) progressModal.classList.add('hidden');
                    if (sBedFacing) sBedFacing.value = 'custom';
                    // Ensure bed contact plane is leveled 100% parallel to build plate (Z = 0) with 0 gap
                    bestTriangles = levelMeshBedContact(bestTriangles);
                    applyNewTriangles(entry, bestTriangles, 'Auto-oriented: Optimal stability & minimal supports');
                    // Settle onto flat resting plane with zero gap
                    applyGravityFall(entry, { forceSettle: true, silent: true });
                }, 120);
            }
        }

        setTimeout(processChunk, 15);
    }

    function autoLayFlat() {
        if (!selectedId) return;
        const entry = files.get(selectedId);
        if (!entry || !entry.triangles) return;
        applyGravityFall(entry, { forceSettle: true });
    }

    // ── Bambu Studio "Lay on Face / Orient by Face" System ───────────────────
    // Implements the 3D Convex Hull ("Balloon Shrink-Wrap") principle:
    // When a model is placed on a flat build plate, contact points MUST lie on the
    // convex hull (the surface of a balloon shrinking around the model).
    let faceDiscsGroup = null;
    let hoveredDisc = null;

    function cross2D(o, a, b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    }

    // Inset 2D polygon inward and round all corners with smooth quadratic Bézier arcs (Bambu Studio style)
    function insetAndRoundPolygon(hull2D) {
        if (!hull2D || hull2D.length < 3) return { rounded: hull2D, c2x: 0, c2y: 0 };

        // 1. Compute 2D Centroid
        let c2x = 0, c2y = 0;
        hull2D.forEach(p => { c2x += p.x; c2y += p.y; });
        c2x /= hull2D.length;
        c2y /= hull2D.length;

        // 2. Inset polygon inward toward centroid (78% scale creates a clean, visible offset margin like Bambu Studio)
        const shrinkFactor = 0.78;
        const insetPoly = hull2D.map(p => {
            const dx = p.x - c2x;
            const dy = p.y - c2y;
            return {
                x: c2x + dx * shrinkFactor,
                y: c2y + dy * shrinkFactor
            };
        });

        // 3. Round corners with smooth quadratic Bézier arcs
        const n = insetPoly.length;
        const rounded = [];

        for (let i = 0; i < n; i++) {
            const prev = insetPoly[(i - 1 + n) % n];
            const curr = insetPoly[i];
            const next = insetPoly[(i + 1) % n];

            const v1x = prev.x - curr.x, v1y = prev.y - curr.y;
            const v2x = next.x - curr.x, v2y = next.y - curr.y;

            const len1 = Math.hypot(v1x, v1y);
            const len2 = Math.hypot(v2x, v2y);

            if (len1 < 0.2 || len2 < 0.2) {
                rounded.push(curr);
                continue;
            }

            // Fillet radius up to 36% of edge length, capped at 3.5mm
            const fillet = Math.min(len1 * 0.36, len2 * 0.36, 3.5);

            const sX = curr.x + (v1x / len1) * fillet;
            const sY = curr.y + (v1y / len1) * fillet;

            const eX = curr.x + (v2x / len2) * fillet;
            const eY = curr.y + (v2y / len2) * fillet;

            const steps = 4;
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const omt = 1 - t;
                const x = omt * omt * sX + 2 * omt * t * curr.x + t * t * eX;
                const y = omt * omt * sY + 2 * omt * t * curr.y + t * t * eY;
                rounded.push({ x, y });
            }
        }

        return { rounded, c2x, c2y };
    }

    // Build translucent landing planes on the planar facets and 3D Convex Hull ("balloon shrink-wrap")
    function buildBalloonHullPlanesGroup(entry) {
        if (!entry || !entry.triangles || !entry.mesh) return null;
        const group = new THREE.Group();
        group.name = 'faceDiscsGroup';

        // 1. Calculate mesh center in STL space (to map from STL coordinates to mesh local coordinates)
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < entry.triangles.length; i++) {
            const { v1, v2, v3 } = entry.triangles[i];
            for (const v of [v1, v2, v3]) {
                if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
                if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
                if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
            }
        }
        const cX = (minX + maxX) / 2, cY = (minY + maxY) / 2, cZ = (minZ + maxZ) / 2;

        const allClusters = [];

        // Sample points for exterior testing and convex hull
        const posAttr = entry.mesh.geometry.attributes.position;
        const totalVerts = posAttr ? posAttr.count : 0;
        const step = Math.max(1, Math.floor(totalVerts / 800));
        const samplePoints = [];
        if (posAttr) {
            for (let i = 0; i < totalVerts; i += step) {
                samplePoints.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
            }
        }

        // 2. Extract genuine exterior planar regions of the mesh (e.g. flat cut base, CAD flat surfaces)
        const meshPlanar = extractPlanarRegions(entry.triangles);
        meshPlanar.forEach(mp => {
            const localPts = mp.points.map(p => new THREE.Vector3(p.x - cX, p.y - cY, p.z - cZ));
            const norm = mp.normal.clone().normalize();

            // Exterior hull verification: check if any vertices in the model stick out beyond this plane.
            // Genuine exterior flat faces (flat cut base, CAD flat faces) have ~0 penetration.
            // Internal or curved surface facets (like the slope of a tree base or trunk) have large penetration (>10-100mm)
            // and must NOT be shown as landing planes stuck to the tree surface.
            let clusterMaxD = -Infinity;
            localPts.forEach(pt => {
                const dot = norm.dot(pt);
                if (dot > clusterMaxD) clusterMaxD = dot;
            });

            let modelMaxD = -Infinity;
            samplePoints.forEach(v => {
                const dot = norm.dot(v);
                if (dot > modelMaxD) modelMaxD = dot;
            });

            if (modelMaxD - clusterMaxD > 1.5) return; // Skip non-resting surface facets

            allClusters.push({
                normal: norm,
                d: clusterMaxD,
                points: localPts,
                area: mp.area,
                isMesh: true
            });
        });

        // 3. Supplement with exterior resting planes from 3D Convex Hull ("balloon shrink-wrap")
        if (THREE.ConvexHull && samplePoints.length >= 4) {
            try {
                const hull = new THREE.ConvexHull();
                hull.setFromPoints(samplePoints);

                if (hull.faces && hull.faces.length > 0) {
                    const hullClusters = [];
                    hull.faces.forEach(face => {
                        const n = face.normal;
                        const p = face.edge.head().point;
                        const d = n.dot(p);

                        // If already covered by a genuine exterior mesh planar region, don't duplicate
                        const alreadyCovered = allClusters.some(mc => mc.normal.dot(n) > 0.965 && Math.abs(mc.d - d) < 4.0);
                        if (alreadyCovered) return;

                        let matched = null;
                        for (const c of hullClusters) {
                            if (c.normal.dot(n) > 0.965 && Math.abs(c.d - d) < 4.0) {
                                matched = c; break;
                            }
                        }

                        const poly = [];
                        let edge = face.edge;
                        do {
                            poly.push(edge.head().point.clone());
                            edge = edge.next;
                        } while (edge !== face.edge);

                        let faceArea = 0;
                        if (poly.length >= 3) {
                            for (let k = 1; k < poly.length - 1; k++) {
                                const vA = poly[0], vB = poly[k], vC = poly[k + 1];
                                const ab = new THREE.Vector3().subVectors(vB, vA);
                                const ac = new THREE.Vector3().subVectors(vC, vA);
                                faceArea += new THREE.Vector3().crossVectors(ab, ac).length() * 0.5;
                            }
                        }

                        if (matched) {
                            matched.faces.push(face);
                            matched.points.push(...poly);
                            matched.area += faceArea;
                        } else {
                            hullClusters.push({
                                normal: n.clone(),
                                d: d,
                                faces: [face],
                                points: [...poly],
                                area: faceArea,
                                isMesh: false
                            });
                        }
                    });

                    hullClusters.sort((a, b) => b.area - a.area);
                    allClusters.push(...hullClusters.filter(c => c.area >= 20));
                }
            } catch (err) {
                console.warn('ConvexHull calculation error:', err);
            }
        }

        allClusters.sort((a, b) => b.area - a.area);
        const topClusters = allClusters.slice(0, 35);

        topClusters.forEach((cluster, idx) => {
            const n = cluster.normal.clone().normalize();
            const pts = cluster.points;
            if (pts.length === 0) return;

            let cx = 0, cy = 0, cz = 0;
            pts.forEach(pt => { cx += pt.x; cy += pt.y; cz += pt.z; });
            cx /= pts.length; cy /= pts.length; cz /= pts.length;
            const center = new THREE.Vector3(cx, cy, cz);

            const up = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
            const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
            const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

            const pts2D = pts.map(pt => {
                const diff = new THREE.Vector3().subVectors(pt, center);
                return { x: diff.dot(uAxis), y: diff.dot(vAxis), pt };
            });

            pts2D.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
            const lower = [];
            for (const p of pts2D) {
                while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                    lower.pop();
                }
                lower.push(p);
            }
            const upper = [];
            for (let k = pts2D.length - 1; k >= 0; k--) {
                const p = pts2D[k];
                while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                    upper.pop();
                }
                upper.push(p);
            }
            lower.pop(); upper.pop();
            const hull2D = lower.concat(upper);

            if (hull2D.length < 3) return;

            let maxDist = 0;
            hull2D.forEach(p => {
                const d = Math.hypot(p.x, p.y);
                if (d > maxDist) maxDist = d;
            });
            if (maxDist < 2.0) return;

            // Inset and round corners to match Bambu Studio landing pads
            const { rounded, c2x, c2y } = insetAndRoundPolygon(hull2D);
            if (!rounded || rounded.length < 3) return;

            // Offset +0.28mm along normal so patch sits proud on the balloon surface
            const offset = n.clone().multiplyScalar(0.28);
            const cPos = center.clone()
                .add(uAxis.clone().multiplyScalar(c2x))
                .add(vAxis.clone().multiplyScalar(c2y))
                .add(offset);

            const poly3D = rounded.map(h => {
                return center.clone()
                    .add(uAxis.clone().multiplyScalar(h.x))
                    .add(vAxis.clone().multiplyScalar(h.y))
                    .add(offset);
            });

            const vertPositions = [];
            const borderPositions = [];

            for (let k = 0; k < poly3D.length; k++) {
                const p1 = poly3D[k];
                const p2 = poly3D[(k + 1) % poly3D.length];

                vertPositions.push(cPos.x, cPos.y, cPos.z);
                vertPositions.push(p1.x, p1.y, p1.z);
                vertPositions.push(p2.x, p2.y, p2.z);

                borderPositions.push(p1.x, p1.y, p1.z);
                borderPositions.push(p2.x, p2.y, p2.z);
            }

            const patchGeo = new THREE.BufferGeometry();
            patchGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertPositions, 3));
            patchGeo.computeVertexNormals();

            const patchMat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.55,
                side: THREE.DoubleSide,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1.5,
                polygonOffsetUnits: -1.5
            });
            const patchMesh = new THREE.Mesh(patchGeo, patchMat);

            const borderGeo = new THREE.BufferGeometry();
            borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderPositions, 3));
            const borderMat = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.88,
                linewidth: 2
            });
            const borderMesh = new THREE.LineSegments(borderGeo, borderMat);

            // BufferGeometry normal directly corresponds to STL normal
            const stlNormal = [n.x, n.y, n.z];

            const patchGroup = new THREE.Group();
            patchGroup.userData = {
                isFaceDisc: true,
                normal: stlNormal,
                center: [cPos.x, cPos.y, cPos.z],
                patchIndex: idx
            };
            patchGroup.add(patchMesh);
            patchGroup.add(borderMesh);

            group.add(patchGroup);
        });

        return group;
    }

    function highlightDisc(discGroup) {
        const mesh = discGroup.children.find(c => c.isMesh);
        if (mesh && mesh.material) {
            mesh.material.color.setHex(0x00ae42); // Bambu green glow
            mesh.material.opacity = 0.88;
        }
        const lines = discGroup.children.find(c => c.isLineSegments);
        if (lines && lines.material) {
            lines.material.color.setHex(0x10b981);
            lines.material.opacity = 1.0;
        }
        const arrow = discGroup.children.find(c => c.isArrowHelper || c.type === 'ArrowHelper');
        if (arrow && arrow.setColor) {
            arrow.setColor(new THREE.Color(0x00ae42));
        }
    }

    function unhighlightDisc(discGroup) {
        const mesh = discGroup.children.find(c => c.isMesh);
        if (mesh && mesh.material) {
            mesh.material.color.setHex(0xffffff); // Translucent white
            mesh.material.opacity = 0.58;
        }
        const lines = discGroup.children.find(c => c.isLineSegments);
        if (lines && lines.material) {
            lines.material.color.setHex(0xffffff);
            lines.material.opacity = 0.90;
        }
        const arrow = discGroup.children.find(c => c.isArrowHelper || c.type === 'ArrowHelper');
        if (arrow && arrow.setColor) {
            arrow.setColor(new THREE.Color(0xffffff));
        }
    }

    // Rotates a 3D point [x, y, z] to the build bed vector [0, 0, -1] using Rodrigues' formula (exact match to STLParser)
    function rotatePointToBed(p, targetNormal) {
        const [nx, ny, nz] = targetNormal;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-7) return [p[0], p[1], p[2]];
        const u = [nx/len, ny/len, nz/len];
        const wx = -u[1], wy = u[0];
        const wLen = Math.hypot(wx, wy);
        const dot = -u[2];
        if (wLen < 1e-6 && dot > 0.999) return [p[0], p[1], p[2]];
        if (wLen < 1e-6 && dot < -0.999) return [p[0], -p[1], -p[2]];
        const kx = wx / wLen, ky = wy / wLen;
        const cosT = Math.max(-1, Math.min(1, dot));
        const sinT = wLen;
        const oneMinusCos = 1 - cosT;
        const r00 = cosT + kx*kx*oneMinusCos,       r01 = kx*ky*oneMinusCos,           r02 = ky*sinT;
        const r10 = ky*kx*oneMinusCos,              r11 = cosT + ky*ky*oneMinusCos,    r12 = -kx*sinT;
        const r20 = -ky*sinT,                       r21 = kx*sinT,                     r22 = cosT;
        return [
            r00 * p[0] + r01 * p[1] + r02 * p[2],
            r10 * p[0] + r11 * p[1] + r12 * p[2],
            r20 * p[0] + r21 * p[1] + r22 * p[2]
        ];
    }

    // ── Gravity Fall: Settles model onto nearest stable resting face ────────
    // Evaluates resting candidate planes in microseconds using cluster sample points
    function applyGravityFall(entry, options = {}) {
        if (!entry) return false;

        // Ensure any pending/unbaked gizmo transforms are baked into entry.triangles before settling
        if (entry.mesh) {
            const hasUnbakedRot = Math.abs(entry.mesh.rotation.x - (-Math.PI / 2)) > 1e-4 ||
                                  Math.abs(entry.mesh.rotation.y) > 1e-4 ||
                                  Math.abs(entry.mesh.rotation.z) > 1e-4;
            const hasUnbakedScale = Math.abs(entry.mesh.scale.x - 1) > 1e-4 ||
                                    Math.abs(entry.mesh.scale.y - 1) > 1e-4 ||
                                    Math.abs(entry.mesh.scale.z) > 1e-4;
            if (hasUnbakedRot || hasUnbakedScale) {
                bakeMeshTransform(entry, 'Applied transform');
            }
        }

        if (!entry.triangles) return false;
        const maxAngleDeg = options.maxAngleDeg !== undefined ? options.maxAngleDeg : 25;
        const forceSettle = options.forceSettle || false;

        // 1. Gather all candidate landing plane normals
        const candidateNormals = [];
        const planarClusters = extractPlanarRegions(entry.triangles);
        for (const c of planarClusters) {
            const dot = -c.normal.z;
            const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
            if (!forceSettle && angleDeg > maxAngleDeg) continue;

            candidateNormals.push({
                normal: [c.normal.x, c.normal.y, c.normal.z],
                area: c.area,
                points: c.points,
                angleDeg: angleDeg,
                isMesh: true
            });
        }

        // Add major non-orthogonal normals if needed
        const majorNormals = getMajorPlanarNormals(entry.triangles, 8);
        for (const mn of majorNormals) {
            const dot = -mn[2];
            const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
            if (!forceSettle && angleDeg > maxAngleDeg) continue;

            if (!candidateNormals.some(ex => (ex.normal[0]*mn[0] + ex.normal[1]*mn[1] + ex.normal[2]*mn[2]) > 0.98)) {
                candidateNormals.push({ normal: mn, area: 25, points: null, angleDeg: angleDeg, isMesh: true });
            }
        }

        // Always include exterior hull normals alongside planar facets to ensure all resting poses are candidates
        if (window.THREE && THREE.ConvexHull && entry.mesh) {
            try {
                const posAttr = entry.mesh.geometry.attributes.position;
                const totalVerts = posAttr.count;
                const step = Math.max(1, Math.floor(totalVerts / 400));
                const samplePoints = [];
                for (let i = 0; i < totalVerts; i += step) {
                    samplePoints.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
                }
                const hull = new THREE.ConvexHull();
                hull.setFromPoints(samplePoints);
                hull.faces.forEach(f => {
                    const hn = [f.normal.x, f.normal.y, f.normal.z];
                    const dot = -hn[2];
                    const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
                    if (!forceSettle && angleDeg > maxAngleDeg) return;
                    if (!candidateNormals.some(ex => (ex.normal[0]*hn[0] + ex.normal[1]*hn[1] + ex.normal[2]*hn[2]) > 0.96)) {
                        candidateNormals.push({ normal: hn, area: 20, points: null, angleDeg: angleDeg, isMesh: false });
                    }
                });
            } catch (e) {}
        }

        if (candidateNormals.length === 0) return false;

        // 2. Evaluate candidates in microseconds without cloning 100k triangles
        const meshCom = entry.geometry.centerOfMass || calculateMeshCenterOfMass(entry.triangles);
        let bestCandidate = null;

        for (const cand of candidateNormals) {
            const angleDeg = cand.angleDeg;
            let isStable = true;
            let contactArea = cand.area;

            if (cand.points && cand.points.length >= 3) {
                const rotPts = cand.points.map(p => rotatePointToBed([p.x, p.y, p.z], cand.normal));
                const hull = compute2DConvexHull(rotPts.map(p => [p[0], p[1]]));
                const rotCom = rotatePointToBed([meshCom.x, meshCom.y, meshCom.z], cand.normal);
                isStable = hull.length >= 3 ? isPointInConvexPolygon(hull, rotCom[0], rotCom[1], 1.5) : false;
            }

            // Priority:
            // 1. Prefer physically stable resting face
            // 2. Prefer small tilt angle (closest face)
            // 3. Prefer solid bed contact area
            const score = (isStable ? 0 : 600)
                        + angleDeg * 2.0
                        - Math.min(contactArea, 300) * 0.15;

            if (!bestCandidate || score < bestCandidate.score) {
                bestCandidate = {
                    normal: cand.normal,
                    angle: angleDeg,
                    isStable,
                    contactArea,
                    score
                };
            }
        }

        if (bestCandidate && (forceSettle || bestCandidate.angle <= maxAngleDeg)) {
            if (bestCandidate.angle > 0.08) {
                let settled = STLParser.rotateTrianglesToNormal(entry.triangles, bestCandidate.normal);
                // Ensure flat base sits 100% flush against bed with 0 gap
                settled = levelMeshBedContact(settled);
                if (sBedFacing) sBedFacing.value = 'custom';
                const msg = options.toastPrefix
                    ? `${options.toastPrefix}: Settled by gravity (tilted ${bestCandidate.angle.toFixed(1)}° → 0°)`
                    : `🎯 Gravity Fall: Settled flat onto bed (tilted ${bestCandidate.angle.toFixed(1)}° → 0°)`;
                applyNewTriangles(entry, settled, msg);
                return true;
            } else if (forceSettle && !options.silent) {
                showToast('Model is already resting completely flat on the build plate', 'info', 2500);
            }
        } else if (forceSettle && !options.silent) {
            showToast('No stable resting face found for Gravity Fall', 'warn', 2500);
        }
        return false;
    }

    function activatePickMode() {
        isPickingFace = true;
        const entry = selectedId ? files.get(selectedId) : null;
        if (!entry || !entry.mesh) return;

        // Add Bambu Studio candidate shrink-wrapped face planes from 3D Convex Hull
        if (!faceDiscsGroup) {
            faceDiscsGroup = buildBalloonHullPlanesGroup(entry);
            if (faceDiscsGroup) entry.mesh.add(faceDiscsGroup);
        }

        if (renderer) renderer.domElement.style.cursor = 'default';
        showToast('🧭 Click any exterior planar facet on the balloon to lay that face flat on the build plate', 'info', 4000);
    }

    function deactivatePickMode() {
        isPickingFace = false;
        if (faceDiscsGroup) {
            if (faceDiscsGroup.parent) {
                faceDiscsGroup.parent.remove(faceDiscsGroup);
            }
            faceDiscsGroup.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            });
            faceDiscsGroup = null;
        }
        hoveredDisc = null;
        if (hoverFaceMesh) hoverFaceMesh.visible = false;
        if (tangentGuide) tangentGuide.visible = false;
        if (renderer) renderer.domElement.style.cursor = 'default';
    }

    // Track mouse press to distinguish camera orbit drag from intentional click / compass drag
    viewerWrap.addEventListener('pointerdown', (ev) => {
        downX = ev.clientX;
        downY = ev.clientY;

        if (ev.button !== 0) return;
        if (currentMode === 'layouts' && currentLayoutTool === 'rotate' && compassGizmo && compassGizmo.visible && selectedLayoutMesh) {
            const rect = renderer.domElement.getBoundingClientRect();
            mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);

            const hitHandles = raycaster.intersectObjects([
                compassGizmo.userData.handleHit,
                compassGizmo.userData.ringHit
            ], true);

            if (hitHandles.length > 0) {
                ev.stopImmediatePropagation();
                ev.preventDefault();
                isDraggingCompass = true;
                if (renderer) renderer.domElement.style.cursor = 'grabbing';
                if (controls) controls.enabled = false;

                if (raycaster.ray.intersectPlane(compassBedPlane, compassPlaneIntersect)) {
                    const cx = selectedLayoutMesh.position.x;
                    const cz = selectedLayoutMesh.position.z;
                    compassStartAngle = Math.atan2(compassPlaneIntersect.z - cz, compassPlaneIntersect.x - cx);
                    compassStartPartRot = selectedLayoutMesh.rotation.y || 0;

                    if (compassTooltip) {
                        compassTooltip.classList.remove('hidden');
                        const deg = ((-compassStartPartRot * 180 / Math.PI) % 360 + 360) % 360;
                        if (compassAngleVal) compassAngleVal.textContent = deg.toFixed(4);
                        compassTooltip.style.left = (ev.clientX - rect.left) + 'px';
                        compassTooltip.style.top = (ev.clientY - rect.top) + 'px';
                    }
                }
            }
        }
    }, { capture: true });

    window.addEventListener('pointermove', (ev) => {
        if (!renderer || !camera) return;

        // 1. Compass drag
        if (isDraggingCompass && selectedLayoutMesh && compassGizmo) {
            const rect = renderer.domElement.getBoundingClientRect();
            mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);

            if (raycaster.ray.intersectPlane(compassBedPlane, compassPlaneIntersect)) {
                const cx = selectedLayoutMesh.position.x;
                const cz = selectedLayoutMesh.position.z;
                const curMouseAngle = Math.atan2(compassPlaneIntersect.z - cz, compassPlaneIntersect.x - cx);
                const delta = curMouseAngle - compassStartAngle;
                let rawAngle = compassStartPartRot - delta;

                // Degrees in clockwise display [0, 360)
                let deg = ((-rawAngle * 180 / Math.PI) % 360 + 360) % 360;

                // Snapping:
                const nearest45 = Math.round(deg / 45) * 45;
                if (Math.abs(deg - nearest45) <= 2.5) {
                    deg = (nearest45 % 360 + 360) % 360;
                } else if (!ev.shiftKey) {
                    deg = (Math.round(deg / 5) * 5 % 360 + 360) % 360;
                }

                const snappedRad = -((deg * Math.PI) / 180);
                selectedLayoutMesh.rotation.y = snappedRad;
                const p = selectedLayoutMesh.userData.part;
                if (p) p.rotY = snappedRad;

                updateCompassHandleAngle(snappedRad);

                if (selectionBox && selectionBox.visible) {
                    selectionBox.setFromObject(selectedLayoutMesh);
                }

                if (compassTooltip) {
                    if (compassAngleVal) compassAngleVal.textContent = deg.toFixed(4);
                    compassTooltip.style.left = (ev.clientX - rect.left) + 'px';
                    compassTooltip.style.top = (ev.clientY - rect.top) + 'px';
                }

                checkLayoutPlateCollisions(activePlateIndex);
            }
            return;
        }

        // 2. Hover over compass handle or ring: show grab cursor
        if (currentMode === 'layouts' && currentLayoutTool === 'rotate' && compassGizmo && compassGizmo.visible) {
            const rect = renderer.domElement.getBoundingClientRect();
            if (ev.clientX >= rect.left && ev.clientX <= rect.right &&
                ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
                mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
                mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(mouse, camera);

                const hitHandles = raycaster.intersectObjects([
                    compassGizmo.userData.handleHit,
                    compassGizmo.userData.ringHit
                ], true);

                if (hitHandles.length > 0) {
                    renderer.domElement.style.cursor = 'grab';
                    return;
                } else if (renderer.domElement.style.cursor === 'grab') {
                    renderer.domElement.style.cursor = 'default';
                }
            }
        }
    });

    window.addEventListener('pointerup', () => {
        if (isDraggingCompass) {
            isDraggingCompass = false;
            if (controls) controls.enabled = true;
            if (compassTooltip) compassTooltip.classList.add('hidden');
            if (renderer) renderer.domElement.style.cursor = 'default';
            checkLayoutPlateCollisions(activePlateIndex);
        }
    });

    // Mousemove hover listener: highlights landing discs or mesh surface
    viewerWrap.addEventListener('mousemove', (ev) => {
        if (!isPickingFace || !selectedId || !scene || !camera) return;

        const entry = files.get(selectedId);
        if (!entry || !entry.mesh) return;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        // 1. First priority: raycast against candidate face landing discs
        if (faceDiscsGroup && faceDiscsGroup.children.length > 0) {
            const discHits = raycaster.intersectObjects(faceDiscsGroup.children, true);
            if (discHits.length > 0) {
                let hitGroup = discHits[0].object;
                while (hitGroup && !hitGroup.userData.isFaceDisc && hitGroup.parent) {
                    hitGroup = hitGroup.parent;
                }
                if (hitGroup && hitGroup.userData.isFaceDisc) {
                    if (hoveredDisc !== hitGroup) {
                        if (hoveredDisc) unhighlightDisc(hoveredDisc);
                        hoveredDisc = hitGroup;
                        highlightDisc(hoveredDisc);
                    }
                    if (renderer) renderer.domElement.style.cursor = 'pointer';
                    hoverFaceMesh.visible = false;
                    if (tangentGuide) tangentGuide.visible = false;
                    return;
                }
            }
        }

        if (hoveredDisc) {
            unhighlightDisc(hoveredDisc);
            hoveredDisc = null;
            if (renderer) renderer.domElement.style.cursor = 'default';
        }

        // 2. Secondary: direct mesh surface hover highlight
        const intersects = raycaster.intersectObject(entry.mesh, false);
        if (intersects.length > 0) {
            const hit = intersects[0];
            if (hit.face && typeof hit.faceIndex === 'number') {
                const connectedIndices = getConnectedCoplanarTriangles(entry, hit.faceIndex);
                const count = Math.min(connectedIndices.length, MAX_HIGHLIGHT_TRIS);
                const posAttr = entry.mesh.geometry.attributes.position;
                const matrixWorld = entry.mesh.matrixWorld;
                const vTmp = new THREE.Vector3();
                let outOffset = 0;

                for (let i = 0; i < count; i++) {
                    const tIdx = connectedIndices[i];
                    const a = tIdx * 3;
                    const b = a + 1;
                    const c = a + 2;

                    vTmp.set(posAttr.getX(a), posAttr.getY(a), posAttr.getZ(a)).applyMatrix4(matrixWorld);
                    hoverFacePositions[outOffset++] = vTmp.x;
                    hoverFacePositions[outOffset++] = vTmp.y;
                    hoverFacePositions[outOffset++] = vTmp.z;

                    vTmp.set(posAttr.getX(b), posAttr.getY(b), posAttr.getZ(b)).applyMatrix4(matrixWorld);
                    hoverFacePositions[outOffset++] = vTmp.x;
                    hoverFacePositions[outOffset++] = vTmp.y;
                    hoverFacePositions[outOffset++] = vTmp.z;

                    vTmp.set(posAttr.getX(c), posAttr.getY(c), posAttr.getZ(c)).applyMatrix4(matrixWorld);
                    hoverFacePositions[outOffset++] = vTmp.x;
                    hoverFacePositions[outOffset++] = vTmp.y;
                    hoverFacePositions[outOffset++] = vTmp.z;
                }

                hoverFaceGeo.attributes.position.needsUpdate = true;
                hoverFaceGeo.setDrawRange(0, count * 3);
                hoverFaceMesh.visible = true;

                if (tangentGuide) {
                    const worldNormal = hit.face.normal.clone().applyEuler(hit.object.rotation).normalize();
                    tangentGuide.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
                    tangentGuide.position.copy(hit.point).addScaledVector(worldNormal, 0.4);
                    const b = entry.geometry.bounds;
                    const maxDim = Math.max(b.width, b.depth, b.height);
                    const s = Math.max(0.6, Math.min(2.2, maxDim / 80));
                    tangentGuide.scale.set(s, s, s);
                    tangentGuide.visible = true;
                }
                if (renderer) renderer.domElement.style.cursor = 'pointer';
                return;
            }
        }

        hoverFaceMesh.visible = false;
        if (tangentGuide) tangentGuide.visible = false;
        if (renderer) renderer.domElement.style.cursor = 'default';
    });

    // Canvas click raycaster: snaps selected disc or face flat to build plate,
    // activates tool on clicked object, or deselects and exits tool when clicking outside
    viewerWrap.addEventListener('click', (ev) => {
        if (!scene || !camera || !renderer) return;

        // Avoid clicking when orbiting / dragging
        const dragDist = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        if (dragDist > 6) return;

        // Only process direct clicks on the WebGL canvas (never toolbar buttons, inspector, or modal)
        if (ev.target !== renderer.domElement) return;

        // Never deselect or exit tool if user was interacting with TransformControls
        if (transformControls && (
            transformControls.dragging ||
            transformControls.axis !== null ||
            (Date.now() - lastGizmoEndTime < 350)
        )) {
            return;
        }

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        // Also check if raycast intersects TransformControls handles (excluding drag plane)
        if (transformControls && transformControls.visible && transformControls._gizmo) {
            const gizmoHits = raycaster.intersectObjects(transformControls._gizmo.children, true);
            const hitHandle = gizmoHits.find(h => h.object && h.object.name && h.object.name !== '');
            if (hitHandle) return;
        }

        // Layouts Mode 3D Selection & Gizmo Interaction
        if (currentMode === 'layouts') {
            if (isDraggingCompass) return;
            if (!layoutPlateGroup || layoutPlateGroup.children.length === 0) return;
            const hits = raycaster.intersectObjects(layoutPlateGroup.children, true);
            if (hits.length > 0) {
                let hitPart = hits[0].object;
                while (hitPart && !hitPart.userData.isPlatePart && hitPart.parent) {
                    hitPart = hitPart.parent;
                }
                if (hitPart && hitPart.userData && hitPart.userData.isPlatePart) {
                    selectLayoutPart(hitPart);
                } else {
                    selectLayoutPart(null);
                }
            } else {
                selectLayoutPart(null);
            }
            return;
        }

        const currentEntry = selectedId ? files.get(selectedId) : null;

        if (isPickingFace && currentEntry && currentEntry.mesh) {
            let targetNormal = null;

            // 1. Check if clicked a candidate landing disc
            if (faceDiscsGroup && faceDiscsGroup.children.length > 0) {
                const discHits = raycaster.intersectObjects(faceDiscsGroup.children, true);
                if (discHits.length > 0) {
                    let hitGroup = discHits[0].object;
                    while (hitGroup && !hitGroup.userData.isFaceDisc && hitGroup.parent) {
                        hitGroup = hitGroup.parent;
                    }
                    if (hitGroup && hitGroup.userData && hitGroup.userData.normal) {
                        targetNormal = hitGroup.userData.normal;
                    }
                }
            }

            // 2. Fallback: clicked directly on a facet of the mesh
            if (!targetNormal) {
                const meshHits = raycaster.intersectObject(currentEntry.mesh, false);
                if (meshHits.length > 0 && meshHits[0].face) {
                    const hit = meshHits[0];
                    const connectedIndices = getConnectedCoplanarTriangles(currentEntry, hit.faceIndex);
                    const { triNormals } = currentEntry.adjacency;
                    let avgNx = 0, avgNy = 0, avgNz = 0;
                    for (const idx of connectedIndices) {
                        avgNx += triNormals[idx * 3];
                        avgNy += triNormals[idx * 3 + 1];
                        avgNz += triNormals[idx * 3 + 2];
                    }
                    const len = Math.hypot(avgNx, avgNy, avgNz);
                    targetNormal = len > 1e-6
                        ? [avgNx / len, avgNy / len, avgNz / len]
                        : [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z];
                }
            }

            if (targetNormal) {
                const rotated = STLParser.rotateTrianglesToNormal(currentEntry.triangles, targetNormal);
                if (sBedFacing) sBedFacing.value = 'custom';
                applyNewTriangles(currentEntry, rotated, '🧭 Snapped selected face flat to build bed!');
                
                // Regenerate candidate discs and silhouette for the newly rotated orientation
                deactivatePickMode();
                activatePickMode();
                return;
            } else {
                // Clicked outside face discs or object in Lay on Face mode: deselect and exit from the tool
                deactivatePickMode();
                selectFile(null);
                setTransformTool('view');
                if (selectionBox) selectionBox.visible = false;
                if (transformControls) transformControls.detach();
                if (bambuInspector) bambuInspector.classList.add('hidden');
                return;
            }
        }

        // Raycast against all visible model meshes in the scene
        const visibleMeshes = [];
        files.forEach(f => {
            if (f.mesh && f.mesh.visible) visibleMeshes.push(f.mesh);
        });

        const intersects = raycaster.intersectObjects(visibleMeshes, false);
        if (intersects.length > 0) {
            const hitMesh = intersects[0].object;
            let hitEntry = null;
            files.forEach(f => { if (f.mesh === hitMesh) hitEntry = f; });

            if (hitEntry) {
                if (selectedId !== hitEntry.id) {
                    selectFile(hitEntry.id);
                }

                // "once click on a tool clicking an object activate the function"
                if (currentTool === 'rotate') {
                    if (selectionBox) {
                        selectionBox.setFromObject(hitEntry.mesh);
                        selectionBox.visible = true;
                    }
                    if (transformControls) {
                        transformControls.setMode('rotate');
                        transformControls.setSpace('local');
                        transformControls.attach(hitEntry.mesh);
                        updateGizmoSize(hitEntry);
                        transformControls.showX = true;
                        transformControls.showY = true;
                        transformControls.showZ = true;
                    }
                    if (bambuInspector) {
                        bambuInspector.classList.remove('hidden');
                        const p = document.getElementById('panel-rotate');
                        if (p) p.style.display = 'block';
                    }
                } else if (currentTool === 'lay-face') {
                    if (selectionBox) {
                        selectionBox.setFromObject(hitEntry.mesh);
                        selectionBox.visible = true;
                    }
                    activatePickMode();
                } else {
                    if (selectionBox) {
                        selectionBox.setFromObject(hitEntry.mesh);
                        selectionBox.visible = true;
                    }
                }
            }
        } else {
            // Clicked outside on the build plate or background: deselect and exit from the tool!
            deactivatePickMode();
            selectFile(null);
            setTransformTool('view');
            if (selectionBox) selectionBox.visible = false;
            if (transformControls) transformControls.detach();
            if (bambuInspector) bambuInspector.classList.add('hidden');
        }
    });

    // Bambu Studio Toolbar Buttons
    if (toolView) toolView.addEventListener('click', (ev) => { ev.stopPropagation(); setTransformTool('view'); });
    if (toolMove) toolMove.addEventListener('click', (ev) => { ev.stopPropagation(); setTransformTool('move'); });
    if (toolRotate) toolRotate.addEventListener('click', (ev) => { ev.stopPropagation(); setTransformTool('rotate'); });
    if (toolScale) toolScale.addEventListener('click', (ev) => { ev.stopPropagation(); setTransformTool('scale'); });
    if (toolLayFace) toolLayFace.addEventListener('click', (ev) => { ev.stopPropagation(); setTransformTool('lay-face'); });
    if (btnAutoOrient) btnAutoOrient.addEventListener('click', (ev) => { ev.stopPropagation(); autoOrient(); });
    const btnGravityFall = document.getElementById('btn-gravity-fall');
    if (btnGravityFall) {
        btnGravityFall.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!selectedId) {
                showToast('Select a 3D model first', 'warn');
                return;
            }
            const entry = files.get(selectedId);
            if (entry) applyGravityFall(entry, { forceSettle: true });
        });
    }
    if (btnHomeView) btnHomeView.addEventListener('click', (ev) => { ev.stopPropagation(); viewHome(); showToast('Zoom to Fit', 'info', 1500); });

    // ── CAD View Cube: Draggable, Rotatable & Clickable ─────────────────────────
    let isDraggingCube = false;
    let cubeStartX = 0, cubeStartY = 0;
    let cubeLastX = 0, cubeLastY = 0;
    let cubeHasMoved = false;

    function rotateCameraOrbit(deltaTheta, deltaPhi) {
        if (!camera || !controls) return;
        const offset = camera.position.clone().sub(controls.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta -= deltaTheta;
        spherical.phi -= deltaPhi;
        spherical.phi = Math.max(0.02, Math.min(Math.PI - 0.02, spherical.phi));
        offset.setFromSpherical(spherical);
        camera.position.copy(controls.target).add(offset);
        camera.lookAt(controls.target);
        controls.update();
        updateViewCube();
    }

    if (viewCubeEl) {
        viewCubeEl.addEventListener('pointerdown', (ev) => {
            isDraggingCube = true;
            cubeStartX = ev.clientX;
            cubeStartY = ev.clientY;
            cubeLastX = ev.clientX;
            cubeLastY = ev.clientY;
            cubeHasMoved = false;
            if (viewCubeEl) viewCubeEl.style.cursor = 'grabbing';
            ev.preventDefault();
        });
    }

    window.addEventListener('pointermove', (ev) => {
        if (!isDraggingCube) return;
        const dx = ev.clientX - cubeLastX;
        const dy = ev.clientY - cubeLastY;
        if (Math.hypot(ev.clientX - cubeStartX, ev.clientY - cubeStartY) > 3) {
            cubeHasMoved = true;
        }
        cubeLastX = ev.clientX;
        cubeLastY = ev.clientY;
        const rotSpeed = 0.012;
        rotateCameraOrbit(dx * rotSpeed, dy * rotSpeed);
    });

    window.addEventListener('pointerup', () => {
        if (isDraggingCube) {
            isDraggingCube = false;
            if (viewCubeEl) viewCubeEl.style.cursor = 'grab';
        }
    });

    if (cubeHomeBtn) cubeHomeBtn.addEventListener('click', () => { viewHome(); showToast('Home Isometric View', 'info', 1500); });

    if (btnCamProjection) {
        btnCamProjection.addEventListener('click', () => {
            const nextType = currentCameraType === 'orthographic' ? 'perspective' : 'orthographic';
            setCameraProjection(nextType);
            showToast(`Camera: ${nextType === 'orthographic' ? 'Orthographic' : 'Perspective'} View`, 'info', 1500);
        });
    }

    document.querySelectorAll('.cube-face').forEach(face => {
        face.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (cubeHasMoved) {
                cubeHasMoved = false;
                return;
            }
            const view = face.getAttribute('data-view');
            if (view === 'front')       { viewFront();  showToast('Front View', 'info', 1500); }
            else if (view === 'back')   { viewBack();   showToast('Back View', 'info', 1500); }
            else if (view === 'top')    { viewTop();    showToast('Top View', 'info', 1500); }
            else if (view === 'bottom') { viewBottom(); showToast('Bottom View', 'info', 1500); }
            else if (view === 'right')  { viewRight();  showToast('Right View', 'info', 1500); }
            else if (view === 'left')   { viewLeft();   showToast('Left View', 'info', 1500); }
        });
    });

    // Move Inspector inputs
    if (btnCenterModel) {
        btnCenterModel.addEventListener('click', () => {
            if (!selectedId) return;
            const entry = files.get(selectedId);
            if (!entry || !entry.mesh) return;
            entry.mesh.position.set(0, entry.geometry.bounds.height / 2, 0);
            updateMoveInputs(entry);
            checkPlateFit(entry.geometry.bounds);
            if (selectionBox) selectionBox.setFromObject(entry.mesh);
            showToast('Centered on build plate', 'info', 1500);
        });
    }
    if (inpPosX) {
        inpPosX.addEventListener('change', () => {
            if (!selectedId) return;
            const entry = files.get(selectedId);
            if (!entry || !entry.mesh) return;
            entry.mesh.position.x = parseFloat(inpPosX.value) || 0;
            checkPlateFit(entry.geometry.bounds);
            if (selectionBox) selectionBox.setFromObject(entry.mesh);
        });
    }
    if (inpPosY) {
        inpPosY.addEventListener('change', () => {
            if (!selectedId) return;
            const entry = files.get(selectedId);
            if (!entry || !entry.mesh) return;
            entry.mesh.position.z = -(parseFloat(inpPosY.value) || 0);
            checkPlateFit(entry.geometry.bounds);
            if (selectionBox) selectionBox.setFromObject(entry.mesh);
        });
    }

    // Stop propagation on inspector to prevent canvas background clicks from deselecting
    if (bambuInspector) {
        bambuInspector.addEventListener('click', (ev) => ev.stopPropagation());
        bambuInspector.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        bambuInspector.addEventListener('mousedown', (ev) => ev.stopPropagation());
    }

    // Rotate Inspector inputs (Step size, X, Y, Z, Reset)
    function getRotStep() {
        const inp = document.getElementById('inp-rot-step');
        const val = parseFloat(inp ? inp.value : 90);
        return (!isNaN(val) && val !== 0) ? val : 90;
    }
    if (btnRotX) btnRotX.addEventListener('click', (ev) => { ev.stopPropagation(); rotateSelected('x', getRotStep()); });
    if (btnRotY) btnRotY.addEventListener('click', (ev) => { ev.stopPropagation(); rotateSelected('y', getRotStep()); });
    if (btnRotZ) btnRotZ.addEventListener('click', (ev) => { ev.stopPropagation(); rotateSelected('z', getRotStep()); });
    if (btnResetRot) btnResetRot.addEventListener('click', (ev) => { ev.stopPropagation(); snapBedFace('bottom'); });

    // Scale Inspector inputs
    if (inpScalePct) {
        inpScalePct.addEventListener('change', () => {
            if (!selectedId) return;
            const entry = files.get(selectedId);
            if (!entry || !entry.mesh) return;
            const pct = Math.max(5, Math.min(1000, parseFloat(inpScalePct.value) || 100));
            const factor = pct / 100;
            entry.mesh.scale.set(factor, factor, factor);
            bakeMeshTransform(entry, `Scaled to ${pct}%`);
        });
    }
    if (btnResetScale) {
        btnResetScale.addEventListener('click', () => {
            if (!selectedId) return;
            const entry = files.get(selectedId);
            if (!entry || !entry.mesh) return;
            entry.mesh.scale.set(1, 1, 1);
            bakeMeshTransform(entry, 'Reset scale to 100%');
        });
    }

    // Bambu Studio Keyboard Shortcuts: T (Move), R (Rotate), S (Scale), F (Face), V/Esc (View), 1 (Home), 2 (Top)
    window.addEventListener('keydown', (ev) => {
        const tag = document.activeElement ? document.activeElement.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        const k = ev.key.toUpperCase();
        if (k === 'T') {
            setTransformTool('move');
        } else if (k === 'R') {
            setTransformTool('rotate');
        } else if (k === 'S') {
            setTransformTool('scale');
        } else if (k === 'F') {
            setTransformTool('lay-face');
        } else if (k === 'V' || ev.key === 'Escape') {
            setTransformTool('view');
        } else if (ev.key === '1') {
            viewHome();
        } else if (ev.key === '2') {
            viewTop();
        }
    });

    // ── 3MF / Job Data Export ────────────────────────────────────────────────
    function exportJobSpec() {
        if (!selectedId) return;
        const entry = files.get(selectedId);
        if (!entry) return;

        const spec = {
            format: "3D_Print_Management_Job_Spec",
            version: "1.0",
            timestamp: new Date().toISOString(),
            jobDetails: {
                team: entry.config.job.team || "Unassigned",
                requester: entry.config.job.requester || "Unassigned",
                project: entry.config.job.project || "Unassigned",
                priority: entry.config.job.priority || "Normal",
                requiredBy: entry.config.job.date || "None",
                notes: entry.config.job.notes || ""
            },
            model: {
                fileName: entry.name + ".stl",
                dimensionsMm: entry.geometry.bounds,
                volumeCm3: (entry.geometry.volume / 1000).toFixed(2),
                surfaceAreaCm2: (entry.geometry.area / 100).toFixed(2),
                overhangAreaCm2: entry.geometry.overhangArea ? (entry.geometry.overhangArea / 100).toFixed(2) : "0"
            },
            plateSetup: {
                bedPlateSizeMm: [PLATE_SIZE, PLATE_SIZE],
                fitsOnPlate: checkPlateFit(entry.geometry.bounds),
                bedFacing: entry.bedFacing || "bottom",
                layerCount: entry.estimates.totalLayers
            },
            slicerProfile: {
                preset: entry.config.preset || "0.20mm Standard @BBL X1C",
                material: entry.config.material,
                density: entry.config.materialDensity,
                layerHeight: entry.config.layerHeight,
                wallLoops: entry.config.shells.wallLoops,
                topLayers: entry.config.shells.topLayers,
                bottomLayers: entry.config.shells.bottomLayers,
                infillDensity: entry.config.infillDensity,
                supportEnabled: entry.config.supportEnabled,
                speeds: entry.config.speed
            },
            estimates: {
                printTimeFormatted: PrintEstimator.formatTime(entry.estimates.printTimeHours, entry.estimates.printTimeMinutes),
                weightGrams: entry.estimates.weightGrams.toFixed(2),
                prepTimeMinutes: entry.config.prepTimeMinutes
            }
        };

        const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${entry.name}_job_spec.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Job spec exported for 3MF/Slicer loading!`, 'success');
    }

    if (btnExportJob) btnExportJob.addEventListener('click', exportJobSpec);

    // ── Default Config Factory ───────────────────────────────────────────────
    function defaultConfig(profileId = 'bambu_x1c_020_standard') {
        const p   = PRESET_PROFILES[profileId];
        const mat = MATERIALS['PLA'];
        return {
            preset: profileId,
            printer: 'bambu_x1c',
            printerFactor: 1.0,
            material: 'PLA',
            color: mat.defaultColor,
            materialDensity: mat.density,
            pricePerKg: loadGlobalPref('pricePerKg', 20),
            layerHeight: p.layerHeight,
            complexity: 'auto',
            prepTimeMinutes: 6.0,
            minLayerTime: 7.0,
            maxFlow: p.maxFlow,
            infillDensity: p.infillDensity,
            overhead: p.overhead,
            shells: { ...p.shells },
            lineWidth: { ...p.lineWidth },
            speed: { ...p.speed },
            supportEnabled: p.supportEnabled,
            supportOverhead: p.supportOverhead,
            comments: '',
            separatePlate: false,
            job: { team: loadGlobalPref('team',''), requester: loadGlobalPref('requester',''), project: '', priority: 'Normal', date: '', notes: '' },
        };
    }

    function loadGlobalPref(key, fallback) {
        try { const v = localStorage.getItem('3dpe_' + key); return v !== null ? JSON.parse(v) : fallback; } catch { return fallback; }
    }
    function saveGlobalPref(key, value) {
        try { localStorage.setItem('3dpe_' + key, JSON.stringify(value)); } catch {}
    }

    // ── File Ingestion ───────────────────────────────────────────────────────
    // Sequential loading: await each addFile() so heavy parses don't all hit
    // the JS thread simultaneously when multiple files are dropped at once.
    async function addFilesSequential(fileList) {
        for (const f of fileList) {
            await addFile(f);
        }
    }

    fileInput.addEventListener('change', e => {
        addFilesSequential([...e.target.files]);
        e.target.value = '';
    });

    window.addEventListener('dragover', e => { e.preventDefault(); dropOverlay.classList.add('visible'); });
    window.addEventListener('dragleave', e => {
        if (!e.relatedTarget || !document.contains(e.relatedTarget)) dropOverlay.classList.remove('visible');
    });
    window.addEventListener('drop', e => {
        e.preventDefault(); dropOverlay.classList.remove('visible');
        const stlFiles = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.stl'));
        addFilesSequential(stlFiles);
    });

    window.addEventListener('keydown', e => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId &&
            !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
            deleteFile(selectedId);
        }
    });

    // ── Developer Diagnostics Panel (Ctrl+Shift+P) ───────────────────────────
    // Hidden from normal users. Shows live perf data for development / tuning.
    const perfDebug = document.getElementById('perf-debug');
    let perfDebugVisible = false;
    let perfDebugInterval = null;

    function updatePerfDebug() {
        if (!perfDebug || !renderer) return;
        const ri  = renderer.info.render;
        const mem = renderer.info.memory;
        const tri = PerformanceManager.currentSceneTriangles();
        const pct = Math.round((tri / PerformanceManager.BUDGET) * 100);
        const estMB = PerformanceManager.estimateMemoryMB(tri);
        const fps = PerformanceManager.fps;
        const fpsColor = fps >= 50 ? '#7fffb0' : fps >= 30 ? '#ffd87f' : '#ff7f7f';

        perfDebug.innerHTML =
            `<span style="color:#aac4ff;font-weight:bold">◉ PERF DEBUG</span>   <span style="font-size:10px;color:#6680aa">Ctrl+Shift+P to close</span>\n` +
            `─────────────────────────────────────\n` +
            `FPS        <span style="color:${fpsColor}">${fps}</span>\n` +
            `Triangles  ${(tri/1000).toFixed(1)}K  (budget ${pct}% of ${(PerformanceManager.BUDGET/1_000_000).toFixed(1)}M)\n` +
            `Est. GPU   ~${estMB} MB\n` +
            `Draw calls ${ri.calls}\n` +
            `Render △   ${ri.triangles.toLocaleString()}\n` +
            `Geometries ${mem.geometries}   Textures ${mem.textures}\n` +
            `Models     ${files.size}\n` +
            `─────────────────────────────────────\n` +
            `<span style="color:#6680aa">Budget: ${(PerformanceManager.BUDGET/1_000_000).toFixed(1)}M △   (localStorage: agy_perf)</span>`;
    }

    window.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
            e.preventDefault();
            perfDebugVisible = !perfDebugVisible;
            if (perfDebug) perfDebug.style.display = perfDebugVisible ? 'block' : 'none';
            if (perfDebugVisible) {
                updatePerfDebug();
                perfDebugInterval = setInterval(updatePerfDebug, 500);
            } else {
                clearInterval(perfDebugInterval);
            }
        }
    });

    async function addFile(file, meta = {}) {
        // Read the raw buffer first — needed for both the triangle peek and parse
        let buf;
        try {
            buf = await file.arrayBuffer();
        } catch (e) {
            showToast(`Failed to read "${file.name}"`, 'error', 3000);
            return;
        }

        // ── Performance pre-check (free — reads 4 bytes at offset 80) ─────────
        const peekedCount = PerformanceManager.peekTriangleCount(buf);
        if (peekedCount !== null) {
            const ev = PerformanceManager.evaluate(peekedCount);
            if (ev.status === 'heavy' || ev.status === 'critical') {
                const memMB   = PerformanceManager.estimateMemoryMB(peekedCount);
                const kTri    = (peekedCount / 1000).toFixed(0);
                const pct     = Math.round(ev.utilization * 100);
                const icon    = ev.status === 'critical' ? '🔴' : '⚠️';
                const proceed = confirm(
                    `${icon} Heavy model — "${file.name}"\n\n` +
                    `  Triangles : ~${kTri}K\n` +
                    `  Est. GPU  : ~${memMB} MB\n` +
                    `  Budget    : ${pct}% of recommended (${(PerformanceManager.BUDGET/1_000_000).toFixed(1)}M)\n\n` +
                    `Preview performance may decrease.\nLoad anyway?`
                );
                if (!proceed) return;
            }
        }

        // ── Full parse ────────────────────────────────────────────────────────
        const id        = String(nextId++);
        const config    = defaultConfig();
        if (meta.material) config.material = meta.material;
        if (meta.color) config.color = meta.color;
        if (meta.job) Object.assign(config.job, meta.job);

        let geometry;
        const is3MF = file.name.toLowerCase().endsWith('.3mf') || (typeof ThreeMFParser !== 'undefined' && ThreeMFParser.is3MF(buf));
        if (is3MF && typeof ThreeMFParser !== 'undefined') {
            try {
                geometry = await ThreeMFParser.parse(buf.slice(0));
            } catch (err3mf) {
                console.warn('3MF parse failed, falling back to STL:', err3mf);
                geometry = STLParser.parse(buf.slice(0));
            }
        } else {
            geometry = STLParser.parse(buf.slice(0));
        }

        const estimates = PrintEstimator.estimate(geometry, config);

        // originalTriangles is the canonical print-geometry source — never
        // simplify or modify it. All orient/gravity ops work on entry.triangles
        // and rebuild from originalTriangles when the bed facing resets.
        const entry = {
            id,
            name: meta.name || file.name.replace(/\.(stl|3mf)$/i, ''),
            arrayBuffer: buf,
            geometry,
            triangles: geometry.triangles,
            originalTriangles: geometry.triangles, // 🔒 Print geometry — keep untouched
            bedFacing: 'bottom',
            quantity: meta.quantity || 1,
            config,
            estimates,
            mesh: null,
            thumbnailUrl: null
        };
        files.set(id, entry);
        ThumbnailRenderer.captureModel(entry);
        renderFileList();
        selectFile(id);
    }

    // ── File List Rendering ──────────────────────────────────────────────────
    function renderFileList() {
        if (badgeObjectsCount) badgeObjectsCount.textContent = files.size;
        fileList.innerHTML = '';
        if (!files.size) {
            fileList.innerHTML = `<div class="empty-hint"><div class="empty-icon">📂</div><p>Add STL files<br>to get started</p></div>`;
            return;
        }
        files.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'file-card' + (entry.id === selectedId ? ' active' : '');
            const e = entry.estimates;
            const timeStr   = PrintEstimator.formatTime(e.printTimeHours, e.printTimeMinutes);
            const weightStr = `${e.weightGrams.toFixed(1)}g`;
            const team      = entry.config.job.team;
            const proj      = entry.config.job.project;
            const priority  = entry.config.job.priority;
            const metaStr   = [team, proj].filter(Boolean).join(' · ') || 'No job details yet';
            const badgeHtml = priority !== 'Normal'
                ? `<span class="priority-badge ${priority}">${priority}</span>` : '';
            const qty       = entry.quantity || 1;

            if (!entry.thumbnailUrl) {
                ThumbnailRenderer.captureModel(entry);
            }
            const thumbHtml = entry.thumbnailUrl
                ? `<img class="file-card-img-thumb" src="${entry.thumbnailUrl}" alt="${escapeHtml(entry.name)}">`
                : `<div class="file-card-thumb-ph">🧊</div>`;

            card.innerHTML = `
                <div class="file-card-inner">
                    <div class="file-card-thumb-wrap" title="${escapeHtml(entry.name)} 3D Preview">
                        ${thumbHtml}
                    </div>
                    <div class="file-card-content">
                        <div class="file-card-top">
                            <div class="file-card-dot" style="background:${entry.config.color}"></div>
                            <div class="file-card-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
                            <div class="copies-stepper" onclick="event.stopPropagation()" title="Copies">
                                <button type="button" class="btn-step btn-minus" data-id="${entry.id}" title="Decrease copies">−</button>
                                <span class="copies-count">${qty}</span>
                                <button type="button" class="btn-step btn-plus" data-id="${entry.id}" title="Increase copies">+</button>
                            </div>
                            <button class="file-card-del" data-id="${entry.id}" title="Remove (Del)">✕</button>
                        </div>
                        <div class="file-card-stats">
                            <div>${entry.config.material}${badgeHtml}</div>
                            <div><span>${timeStr}</span> · <span>${weightStr}</span></div>
                        </div>
                        <div class="file-card-meta" title="${metaStr}">${metaStr}</div>
                    </div>
                </div>`;

            card.addEventListener('click', () => selectFile(entry.id));
            card.querySelector('.file-card-del').addEventListener('click', ev => { ev.stopPropagation(); deleteFile(entry.id); });
            card.querySelector('.btn-minus').addEventListener('click', ev => {
                ev.stopPropagation();
                entry.quantity = Math.max(1, (entry.quantity || 1) - 1);
                renderFileList();
            });
            card.querySelector('.btn-plus').addEventListener('click', ev => {
                ev.stopPropagation();
                entry.quantity = (entry.quantity || 1) + 1;
                renderFileList();
            });

            // Inline Rename on Double Click
            const nameEl = card.querySelector('.file-card-name');
            if (nameEl) {
                nameEl.setAttribute('title', `${entry.name} (Double-click to rename)`);
                nameEl.addEventListener('dblclick', (ev) => {
                    ev.stopPropagation();
                    const curName = entry.name;
                    const inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'file-card-name-input';
                    inp.value = curName;
                    nameEl.replaceWith(inp);
                    inp.focus();
                    inp.select();

                    let committed = false;
                    const commit = () => {
                        if (committed) return;
                        committed = true;
                        const val = inp.value.trim();
                        if (val && val !== curName) {
                            renameEntry(entry, val);
                            showToast(`✏️ Renamed object to "${val}"`, 'info', 2000);
                        } else {
                            renderFileList();
                        }
                    };
                    inp.addEventListener('blur', commit);
                    inp.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            commit();
                        } else if (e.key === 'Escape') {
                            committed = true;
                            renderFileList();
                        }
                        e.stopPropagation();
                    });
                    inp.addEventListener('click', (e) => e.stopPropagation());
                });
            }
            fileList.appendChild(card);
        });
    }

    function deleteFile(id) {
        const entry = files.get(id);
        if (entry?.mesh) {
            scene?.remove(entry.mesh);
            // Recursively dispose all child geometries, materials, and textures
            // to prevent GPU memory leaks (e.g. balloon-hull child meshes).
            entry.mesh.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                    mats.forEach(m => {
                        if (m.map)         m.map.dispose();
                        if (m.normalMap)   m.normalMap.dispose();
                        if (m.roughnessMap) m.roughnessMap.dispose();
                        m.dispose();
                    });
                }
            });
        }
        files.delete(id);
        const remaining = [...files.keys()];
        selectFile(remaining.length ? remaining[remaining.length - 1] : null);
    }

    // ── File Selection ───────────────────────────────────────────────────────
    function selectFile(id) {
        selectedId = id;
        renderFileList();
        const entry = id ? files.get(id) : null;

        if (!entry) {
            noSelHint.classList.remove('hidden');
            detailsContent.classList.add('hidden');
            if (typeof currentMode !== 'undefined' && currentMode === 'layouts') {
                if (settingsEmpty) settingsEmpty.classList.add('hidden');
                if (settingsForm) settingsForm.classList.add('hidden');
                if (plateSettingsForm) plateSettingsForm.classList.remove('hidden');
            } else {
                if (settingsEmpty) settingsEmpty.classList.remove('hidden');
                if (settingsForm) settingsForm.classList.add('hidden');
            }
            if (files.size === 0) {
                viewerEmpty.style.display = 'flex';
                files.forEach(f => { if (f.mesh) f.mesh.visible = false; });
            } else if (currentMode === 'objects') {
                viewerEmpty.style.display = 'none';
                files.forEach(f => { if (f.mesh) f.mesh.visible = false; });
            }
            if (selectionBox) selectionBox.visible = false;
            if (transformControls) transformControls.detach();
            if (bambuInspector) bambuInspector.classList.add('hidden');
            return;
        }

        noSelHint.classList.add('hidden');
        detailsContent.classList.remove('hidden');
        settingsEmpty.classList.add('hidden');
        settingsForm.classList.remove('hidden');

        if (sBedFacing) sBedFacing.value = entry.bedFacing || 'bottom';

        showMeshForFile(entry);
        populateSettings(entry);
        updateDetails(entry);
    }

    // ── Settings Panel ───────────────────────────────────────────────────────
    let _suppress = false;

    function renameEntry(entry, newName, updateInput = true) {
        if (!entry || !newName) return;
        const cleanName = newName.trim();
        if (!cleanName || cleanName === entry.name) return;
        entry.name = cleanName;
        if (entry.mesh) {
            entry.mesh.name = cleanName;
            if (entry.mesh.userData && entry.mesh.userData.entry) {
                entry.mesh.userData.entry.name = cleanName;
            }
        }
        if (updateInput && sObjectName && selectedId === entry.id) {
            sObjectName.value = cleanName;
        }
        renderFileList();
        updateDetails(entry);
        if (typeof renderBuildPlatesTree === 'function') {
            renderBuildPlatesTree();
        }
        if (typeof renderReviewManifest === 'function') {
            renderReviewManifest();
        }
    }

    function populateSettings(entry) {
        _suppress = true;
        const c = entry.config, j = c.job;

        if (sObjectName) sObjectName.value = entry.name || '';
        const modernObjTitle = document.getElementById('modern-object-title');
        if (modernObjTitle) modernObjTitle.textContent = entry.name || 'Object';
        if (sTeam) sTeam.value       = j.team || '';
        if (sRequester) sRequester.value  = j.requester || '';
        if (sProject) sProject.value    = j.project || '';
        if (sPriority) sPriority.value   = j.priority || 'Normal';
        if (sDate) sDate.value       = j.date || '';
        if (sNotes) sNotes.value      = j.notes || '';
        if (sPartComments) sPartComments.value = c.comments || '';
        if (sSeparatePlate) sSeparatePlate.checked = !!c.separatePlate;
        sMaterial.value   = c.material;
        sColor.value      = c.color;
        sDensity.value    = c.materialDensity;
        sPricePerKg.value = c.pricePerKg;
        sPrinter.value    = c.printer || 'bambu_x1c';
        sLayerHeight.value= c.layerHeight;
        sComplexity.value = c.complexity || 'auto';
        sPrepTime.value   = c.prepTimeMinutes !== undefined ? c.prepTimeMinutes : 6.0;
        sMinLayerTime.value = c.minLayerTime !== undefined ? c.minLayerTime : 7.0;
        sWallLoops.value  = c.shells.wallLoops;
        sTopLayers.value  = c.shells.topLayers;
        sBotLayers.value  = c.shells.bottomLayers;
        sLwOuter.value    = c.lineWidth.outer;
        sLwInner.value    = c.lineWidth.inner;
        sLwInfill.value   = c.lineWidth.infill;
        sLwTopBot.value   = c.lineWidth.topBottom;
        sInfill.value     = c.infillDensity;
        sMaxFlow.value    = c.maxFlow;
        sSpdOuter.value   = c.speed.outer;
        sSpdInner.value   = c.speed.inner;
        sSpdInfill.value  = c.speed.infill;
        sSpdTop.value     = c.speed.top;
        sSpdBot.value     = c.speed.bottom;
        if (sSupports) {
            if (sSupports.tagName === 'SELECT') {
                sSupports.value = c.supportEnabled ? 'tree' : 'none';
            } else {
                sSupports.checked = !!c.supportEnabled;
            }
        }
        sSupportPct.value = c.supportOverhead;
        sOverhead.value   = c.overhead;
        if (sSupportRow) sSupportRow.style.display = c.supportEnabled ? 'flex' : 'none';

        _suppress = false;
    }

    function readSettings(entry) {
        const c = entry.config, j = c.job;
        if (sObjectName) {
            const newName = sObjectName.value.trim();
            if (newName && newName !== entry.name) {
                entry.name = newName;
                if (entry.mesh) {
                    entry.mesh.name = newName;
                    if (entry.mesh.userData && entry.mesh.userData.entry) {
                        entry.mesh.userData.entry.name = newName;
                    }
                }
            }
        }
        if (sTeam) j.team       = sTeam.value;
        if (sRequester) j.requester  = sRequester.value;
        if (sProject) j.project    = sProject.value;
        if (sPriority) j.priority   = sPriority.value;
        if (sDate) j.date       = sDate.value;
        if (sNotes) j.notes      = sNotes.value;
        if (sPartComments) c.comments = sPartComments.value;
        if (sSeparatePlate) c.separatePlate = sSeparatePlate.checked;
        c.material        = sMaterial.value;
        c.color           = sColor.value;
        c.materialDensity = parseFloat(sDensity.value);
        c.pricePerKg      = parseFloat(sPricePerKg.value);
        c.printer         = sPrinter.value;
        const mach        = (typeof PRINTER_MACHINES !== 'undefined' && PRINTER_MACHINES[c.printer]) ? PRINTER_MACHINES[c.printer] : { factor: 1.0 };
        c.printerFactor   = mach.factor;
        c.layerHeight     = parseFloat(sLayerHeight.value);
        c.complexity      = sComplexity.value;
        c.prepTimeMinutes = parseFloat(sPrepTime.value);
        c.minLayerTime    = parseFloat(sMinLayerTime.value);
        c.shells.wallLoops    = parseInt(sWallLoops.value, 10);
        c.shells.topLayers    = parseInt(sTopLayers.value, 10);
        c.shells.bottomLayers = parseInt(sBotLayers.value, 10);
        c.lineWidth.outer     = parseFloat(sLwOuter.value);
        c.lineWidth.inner     = parseFloat(sLwInner.value);
        c.lineWidth.infill    = parseFloat(sLwInfill.value);
        c.lineWidth.topBottom = parseFloat(sLwTopBot.value);
        c.infillDensity   = parseFloat(sInfill.value);
        c.maxFlow         = parseFloat(sMaxFlow.value);
        c.speed.outer     = parseFloat(sSpdOuter.value);
        c.speed.inner     = parseFloat(sSpdInner.value);
        c.speed.infill    = parseFloat(sSpdInfill.value);
        c.speed.top       = parseFloat(sSpdTop.value);
        c.speed.bottom    = parseFloat(sSpdBot.value);
        c.supportEnabled  = (sSupports && sSupports.tagName === 'SELECT') ? (sSupports.value !== 'none') : (sSupports ? sSupports.checked : false);
        c.supportOverhead = parseFloat(sSupportPct.value);
        c.overhead        = parseFloat(sOverhead.value);

        if (j.team) saveGlobalPref('team', j.team);
        if (j.requester) saveGlobalPref('requester', j.requester);
        if (j.project) saveGlobalPref('project', j.project);
        saveGlobalPref('pricePerKg', c.pricePerKg);
    }

    function onSettingChanged() {
        if (_suppress || !selectedId) return;
        const entry = files.get(selectedId);
        if (!entry) return;
        readSettings(entry);
        if (entry.mesh) entry.mesh.material.color.set(entry.config.color);
        ThumbnailRenderer.captureModel(entry);
        entry.estimates = PrintEstimator.estimate(entry.geometry, entry.config);
        renderFileList();
        updateDetails(entry);
    }

    sMaterial.addEventListener('change', () => {
        if (_suppress || !selectedId) return;
        const mat = MATERIALS[sMaterial.value];
        if (mat) { sDensity.value = mat.density; sColor.value = mat.defaultColor; }
        onSettingChanged();
    });

    sPreset.addEventListener('change', () => {
        if (_suppress || !selectedId) return;
        const p = PRESET_PROFILES[sPreset.value];
        if (!p || sPreset.value === 'custom') { onSettingChanged(); return; }
        const entry = files.get(selectedId);
        if (!entry) return;
        entry.config.preset = sPreset.value;
        Object.assign(entry.config, {
            layerHeight: p.layerHeight, maxFlow: p.maxFlow, infillDensity: p.infillDensity,
            overhead: p.overhead, shells: { ...p.shells }, lineWidth: { ...p.lineWidth },
            speed: { ...p.speed }, supportEnabled: p.supportEnabled, supportOverhead: p.supportOverhead,
        });
        populateSettings(entry);
        entry.estimates = PrintEstimator.estimate(entry.geometry, entry.config);
        renderFileList();
        updateDetails(entry);
    });

    btnReset.addEventListener('click', () => {
        if (!selectedId) return;
        const entry  = files.get(selectedId);
        const pid    = sPreset.value !== 'custom' ? sPreset.value : 'bambu_x1c_020_standard';
        const p      = PRESET_PROFILES[pid];
        Object.assign(entry.config, {
            layerHeight: p.layerHeight, maxFlow: p.maxFlow, infillDensity: p.infillDensity,
            overhead: p.overhead, shells: { ...p.shells }, lineWidth: { ...p.lineWidth },
            speed: { ...p.speed }, supportEnabled: p.supportEnabled, supportOverhead: p.supportOverhead,
        });
        populateSettings(entry);
        entry.estimates = PrintEstimator.estimate(entry.geometry, entry.config);
        renderFileList();
        updateDetails(entry);
        showToast('Settings reset to profile defaults', 'success');
    });

    sSupports.addEventListener('change', () => {
        if (sSupportRow) sSupportRow.style.display = sSupports.checked ? 'flex' : 'none';
        onSettingChanged();
    });

    // ── HTML Escaper Helper ──────────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Build Plate Nesting Engine (Bambu Studio Slicer Rules) ───────────────
    const PlateNestEngine = {
        BED_WIDTH: 256,
        BED_DEPTH: 256,
        USABLE_WIDTH: 230,
        USABLE_DEPTH: 230,
        PART_SPACING: 10,

        nest(filesMap) {
            const fileEntries = Array.from(filesMap.values());
            if (fileEntries.length === 0) return { plates: [], needsReview: [], grandTotalHours: 0, grandTotalMinutes: 0, grandTotalWeight: 0, grandTotalCost: 0 };

            const plates = [];
            const needsReview = [];

            for (const entry of fileEntries) {
                const b = entry.geometry.bounds;
                const w = b.width;
                const d = b.depth;
                const h = b.height;
                const mat = entry.config.material;
                const lh = entry.config.layerHeight;
                const isSep = !!entry.config.separatePlate;
                const qty = Math.max(1, parseInt(entry.quantity, 10) || 1);

                // Check for oversized dimensions beyond physical bed (256x256x256)
                if (w > 256 || d > 256 || h > 256) {
                    needsReview.push({
                        entry,
                        quantity: qty,
                        reason: `Exceeds max bed volume (${Math.round(w)}×${Math.round(d)}×${Math.round(h)}mm > 256mm)`
                    });
                    continue;
                }

                for (let copyIdx = 0; copyIdx < qty; copyIdx++) {
                    let placed = false;

                    if (!isSep) {
                        for (const plate of plates) {
                            if (plate.isDedicated) continue;
                            if (plate.material !== mat) continue;
                            if (Math.abs(plate.layerHeight - lh) > 0.001) continue;

                            const pos = PlateNestEngine.findPlacement(plate.parts, w, d);
                            if (pos) {
                                plate.parts.push({
                                    entry,
                                    copyIndex: copyIdx + 1,
                                    posX: pos.x,
                                    posZ: pos.z,
                                    width: w,
                                    depth: d,
                                    height: h
                                });
                                placed = true;
                                break;
                            }
                        }
                    }

                    if (!placed) {
                        let reason = 'Base Plate';
                        if (isSep) {
                            reason = 'Dedicated Separate Plate';
                        } else if (plates.some(p => p.material !== mat)) {
                            reason = `Material Isolated (${mat})`;
                        } else if (plates.some(p => Math.abs(p.layerHeight - lh) > 0.001)) {
                            reason = `Layer Height Isolated (${lh}mm)`;
                        } else if (plates.length > 0) {
                            reason = 'Plate Full (Bed Area Exceeded)';
                        }

                        const newPlate = {
                            id: plates.length + 1,
                            customName: '',
                            printer: entry.config.printer || 'bambu_x1c',
                            material: mat,
                            layerHeight: lh,
                            wallLoops: (entry.config.shells && entry.config.shells.wallLoops) !== undefined ? entry.config.shells.wallLoops : 2,
                            infill: entry.config.infillDensity !== undefined ? entry.config.infillDensity : 30,
                            supports: entry.config.supportEnabled !== undefined ? entry.config.supportEnabled : true,
                            isDedicated: isSep,
                            reason: reason,
                            parts: [{
                                entry,
                                copyIndex: copyIdx + 1,
                                posX: 0,
                                posZ: 0,
                                width: w,
                                depth: d,
                                height: h
                            }]
                        };
                        plates.push(newPlate);
                    }
                }
            }

            let grandTotalMinutes = 0;
            let grandTotalWeight = 0;
            let grandTotalCost = 0;

            for (const plate of plates) {
                let plateWeight = 0;
                let plateCost = 0;
                let maxPrepTime = 0;
                let totalExtrusionMinutes = 0;
                let totalFootprint = 0;

                for (const p of plate.parts) {
                    const e = p.entry.estimates;
                    const c = p.entry.config;
                    plateWeight += e.weightGrams;
                    plateCost += (e.weightGrams / 1000) * c.pricePerKg;
                    totalFootprint += (p.width * p.depth);

                    const prep = (c.prepTimeMinutes !== undefined ? c.prepTimeMinutes : 6.0);
                    if (prep > maxPrepTime) maxPrepTime = prep;

                    const partTotalMins = (e.printTimeHours * 60) + e.printTimeMinutes;
                    totalExtrusionMinutes += Math.max(0, partTotalMins - prep);
                }

                const plateTotalMins = maxPrepTime + totalExtrusionMinutes;
                plate.totalTimeMinutes = Math.round(plateTotalMins % 60);
                plate.totalTimeHours = Math.floor(plateTotalMins / 60);
                plate.totalWeightGrams = plateWeight;
                plate.totalCost = plateCost;
                plate.bedOccupancyPct = Math.min(100, Math.round((totalFootprint / (PlateNestEngine.USABLE_WIDTH * PlateNestEngine.USABLE_DEPTH)) * 100));

                grandTotalMinutes += plateTotalMins;
                grandTotalWeight += plateWeight;
                grandTotalCost += plateCost;
            }

            return {
                plates,
                needsReview,
                grandTotalHours: Math.floor(grandTotalMinutes / 60),
                grandTotalMinutes: Math.round(grandTotalMinutes % 60),
                grandTotalWeight,
                grandTotalCost
            };
        },

        findPlacement(existingParts, w, d) {
            const halfW = w / 2;
            const halfD = d / 2;
            const minX = -PlateNestEngine.USABLE_WIDTH / 2;
            const maxX = PlateNestEngine.USABLE_WIDTH / 2;
            const minZ = -PlateNestEngine.USABLE_DEPTH / 2;
            const maxZ = PlateNestEngine.USABLE_DEPTH / 2;

            if (w > PlateNestEngine.USABLE_WIDTH || d > PlateNestEngine.USABLE_DEPTH) {
                return null;
            }

            const candidates = [{ x: 0, z: 0 }];

            for (const ep of existingParts) {
                const epHalfW = ep.width / 2;
                const epHalfD = ep.depth / 2;
                const gap = PlateNestEngine.PART_SPACING;

                candidates.push({ x: ep.posX + epHalfW + gap + halfW, z: ep.posZ });
                candidates.push({ x: ep.posX - epHalfW - gap - halfW, z: ep.posZ });
                candidates.push({ x: ep.posX, z: ep.posZ + epHalfD + gap + halfD });
                candidates.push({ x: ep.posX, z: ep.posZ - epHalfD - gap - halfD });

                candidates.push({ x: ep.posX + epHalfW + gap + halfW, z: ep.posZ + epHalfD + gap + halfD });
                candidates.push({ x: ep.posX + epHalfW + gap + halfW, z: ep.posZ - epHalfD - gap - halfD });
                candidates.push({ x: ep.posX - epHalfW - gap - halfW, z: ep.posZ + epHalfD + gap + halfD });
                candidates.push({ x: ep.posX - epHalfW - gap - halfW, z: ep.posZ - epHalfD - gap - halfD });
            }

            candidates.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));

            for (const cand of candidates) {
                if (cand.x - halfW < minX || cand.x + halfW > maxX) continue;
                if (cand.z - halfD < minZ || cand.z + halfD > maxZ) continue;

                let collides = false;
                for (const ep of existingParts) {
                    const epHalfW = ep.width / 2;
                    const epHalfD = ep.depth / 2;
                    const minDistanceX = halfW + epHalfW + PlateNestEngine.PART_SPACING;
                    const minDistanceZ = halfD + epHalfD + PlateNestEngine.PART_SPACING;

                    if (Math.abs(cand.x - ep.posX) < minDistanceX - 0.01 &&
                        Math.abs(cand.z - ep.posZ) < minDistanceZ - 0.01) {
                        collides = true;
                        break;
                    }
                }

                if (!collides) {
                    return cand;
                }
            }

            return null;
        },

        reNestPlate(plate) {
            if (!plate || !plate.parts || plate.parts.length === 0) return;
            const placed = [];
            for (let i = 0; i < plate.parts.length; i++) {
                const p = plate.parts[i];
                p.rotY = 0;
                if (i === 0) {
                    p.posX = 0;
                    p.posZ = 0;
                    placed.push(p);
                } else {
                    const pos = PlateNestEngine.findPlacement(placed, p.width, p.depth);
                    if (pos) {
                        p.posX = pos.x;
                        p.posZ = pos.z;
                    } else {
                        p.posX = 0;
                        p.posZ = 0;
                    }
                    placed.push(p);
                }
            }
            let totalFootprint = 0;
            for (const p of plate.parts) {
                totalFootprint += (p.width * p.depth);
            }
            plate.bedOccupancyPct = Math.min(100, Math.round((totalFootprint / (PlateNestEngine.USABLE_WIDTH * PlateNestEngine.USABLE_DEPTH)) * 100));
        }
    };

    // ── Build Plate Nesting Layout Manager ────────────────────────────────────
    let currentNesting = null;
    let activePlateIndex = 0;
    let plateTrayMode = 'minimised'; // 'minimised' | 'expanded'
    const expandedPlateIds = new Set();

    if (btnTrayModeToggle) {
        btnTrayModeToggle.addEventListener('click', () => {
            if (plateTrayMode === 'minimised') {
                plateTrayMode = 'expanded';
                if (currentNesting && currentNesting.plates) {
                    currentNesting.plates.forEach(p => expandedPlateIds.add(p.id));
                }
                if (trayModeIcon) trayModeIcon.textContent = '⊞';
                if (trayModeLabel) trayModeLabel.textContent = 'Expanded';
                btnTrayModeToggle.title = 'Switch to Minimised mode (show plate summary only)';
            } else {
                plateTrayMode = 'minimised';
                expandedPlateIds.clear();
                if (trayModeIcon) trayModeIcon.textContent = '⊟';
                if (trayModeLabel) trayModeLabel.textContent = 'Minimised';
                btnTrayModeToggle.title = 'Switch to Expanded mode (show all files)';
            }
            renderBuildPlatesTree();
        });
    }

    // ── Scope & Plate Naming Utilities ───────────────────────────────────────
    function sanitizeFilename(str) {
        return (str || '').replace(/[/\\:*?"<>|]/g, '_').trim();
    }

    function generateDefaultPlateName(plate) {
        if (!plate) return 'Plate_1.3mf';
        if (plate.customName && plate.customName.trim()) {
            let name = sanitizeFilename(plate.customName.trim());
            if (!name.toLowerCase().endsWith('.3mf')) name += '.3mf';
            return name;
        }
        const partCount = plate.parts ? plate.parts.length : 0;
        const mat = plate.material || 'PLA';
        const lh = (plate.layerHeight !== undefined ? plate.layerHeight : 0.20).toFixed(2) + 'mm';
        const infill = (plate.infill !== undefined ? plate.infill : 30) + 'inf';

        let prefix = '';
        let colorStr = '';
        if (partCount === 1) {
            const p0 = plate.parts[0];
            const rawName = p0.entry ? p0.entry.name.replace(/\.[^/.]+$/, "") : 'Part';
            prefix = sanitizeFilename(rawName);
            if (p0.entry && p0.entry.config && p0.entry.config.color) {
                colorStr = sanitizeFilename(p0.entry.config.colorName || p0.entry.config.color || '');
            }
        } else {
            prefix = `${partCount}Parts`;
        }
        const parts = [prefix, mat];
        if (colorStr) parts.push(colorStr);
        parts.push(lh, infill);
        return parts.join('_') + '.3mf';
    }

    function updatePlateExportPreview(plate) {
        if (!plate || !plateExportPreview) return;
        plateExportPreview.textContent = generateDefaultPlateName(plate);
    }

    function updateScopeBottomBar(scope, data) {
        if (!scopeHeaderStrip || !scopeBadge || !scopeTitle) return;

        if (scope === 'part' && data) {
            scopeBadge.textContent = 'PART';
            scopeBadge.className = 'scope-badge part';
            scopeTitle.textContent = data.entry ? data.entry.name : (data.name || 'Selected Part');
        } else if (scope === 'plate' && data) {
            scopeBadge.textContent = `PLATE ${data.id || (activePlateIndex + 1)}`;
            scopeBadge.className = 'scope-badge plate';
            scopeTitle.textContent = data.customName || `Plate ${data.id || (activePlateIndex + 1)}`;

            // Update metric outputs for active plate
            if (dBounds) dBounds.textContent = `256 × 256 mm Bed`;
            if (dVolume) {
                let totalVol = 0;
                (data.parts || []).forEach(p => { if (p.entry && p.entry.geometry) totalVol += (p.entry.geometry.volume || 0); });
                dVolume.textContent = `${(totalVol / 1000).toFixed(2)} cm³`;
            }
            if (dPolygons) {
                let totalPolys = 0;
                (data.parts || []).forEach(p => { if (p.entry && p.entry.triangles) totalPolys += p.entry.triangles.length; });
                dPolygons.textContent = totalPolys > 0 ? totalPolys.toLocaleString() : '--';
            }
            if (dSupportWeight) dSupportWeight.textContent = (data.supports !== false) ? 'Estimated' : 'None';
            if (dWeight) dWeight.textContent = `${(data.totalWeightGrams || 0).toFixed(1)} g`;
            if (dTime) dTime.textContent = PrintEstimator.formatTime(data.totalTimeHours || 0, data.totalTimeMinutes || 0);
            if (dCost) dCost.textContent = `₹ ${(data.totalCost || 0).toFixed(2)}`;
        } else if (scope === 'job') {
            scopeBadge.textContent = 'JOB SUMMARY';
            scopeBadge.className = 'scope-badge job';
            scopeTitle.textContent = `${data.partsCount || 0} parts across ${data.platesCount || 0} plates`;

            if (dBounds) dBounds.textContent = `${data.platesCount || 0} build plates`;
            if (dSupportWeight) dSupportWeight.textContent = `All Plates`;
            if (dWeight) dWeight.textContent = data.totalWeight || '--';
            if (dTime) dTime.textContent = data.totalTime || '--';
            if (dCost) dCost.textContent = data.totalCost || '--';
        }
    }

    // ── 3-Step Linear Workflow Controller ────────────────────────────────────
    function setWorkflowStage(stage) {
        if (stage === 'layouts') stage = 'plates';
        currentMode = stage;

        if (stage === 'objects') {
            if (stepBtnObjects) {
                stepBtnObjects.classList.add('active');
                if (files.size > 0) {
                    stepBtnObjects.classList.add('completed');
                    if (checkObjects) checkObjects.style.display = 'inline-flex';
                }
            }
            if (stepBtnPlates) stepBtnPlates.classList.remove('active');
            if (stepBtnReview) stepBtnReview.classList.remove('active');

            if (objectsSidebarView) objectsSidebarView.classList.remove('hidden');
            if (layoutsSidebarView) layoutsSidebarView.classList.add('hidden');
            if (reviewStageView)    reviewStageView.classList.add('hidden');
            if (viewerWrap)         viewerWrap.classList.remove('hidden');

            // Viewport tools
            if (toolsObjects) toolsObjects.classList.remove('hidden');
            if (toolsLayouts) toolsLayouts.classList.add('hidden');
            if (bambuToolbar) bambuToolbar.classList.remove('hidden');

            // Right sidebar
            if (plateSettingsForm) plateSettingsForm.classList.add('hidden');
            const st = document.getElementById('settings-title');
            if (st) st.textContent = 'Print Requirements';

            // Topbar navigation buttons
            if (btnContinuePlates) btnContinuePlates.classList.remove('hidden');
            if (btnReviewSubmit)   btnReviewSubmit.classList.add('hidden');
            if (btnSubmitFinal)    btnSubmitFinal.classList.add('hidden');

            selectedLayoutMesh = null;
            if (transformControls) transformControls.detach();
            if (selectionBox) selectionBox.visible = false;
            if (compassGizmo) compassGizmo.visible = false;
            if (compassTooltip) compassTooltip.classList.add('hidden');

            if (layoutPlateGroup) {
                scene.remove(layoutPlateGroup);
                layoutPlateGroup = null;
            }
            update3DPlateLabel('OBJECT');

            if (selectedId && files.has(selectedId)) {
                if (settingsForm) settingsForm.classList.remove('hidden');
                if (settingsEmpty) settingsEmpty.classList.add('hidden');
                const entry = files.get(selectedId);
                showMeshForFile(entry);
                updateScopeBottomBar('part', entry);
            } else if (files.size > 0) {
                selectFile(Array.from(files.keys())[0]);
            } else {
                if (settingsForm) settingsForm.classList.add('hidden');
                if (settingsEmpty) settingsEmpty.classList.remove('hidden');
                if (scopeTitle) scopeTitle.textContent = 'No selection';
            }
        } else if (stage === 'plates') {
            if (files.size === 0) {
                showToast('Please add at least one 3D model first', 'warn');
                return;
            }

            if (stepBtnObjects) {
                stepBtnObjects.classList.remove('active');
                stepBtnObjects.classList.add('completed');
                if (checkObjects) checkObjects.style.display = 'inline-flex';
            }
            if (stepBtnPlates) {
                stepBtnPlates.classList.add('active');
                stepBtnPlates.classList.add('completed');
                if (checkPlates) checkPlates.style.display = 'inline-flex';
            }
            if (stepBtnReview) stepBtnReview.classList.remove('active');

            if (objectsSidebarView) objectsSidebarView.classList.add('hidden');
            if (layoutsSidebarView) layoutsSidebarView.classList.remove('hidden');
            if (reviewStageView)    reviewStageView.classList.add('hidden');
            if (viewerWrap)         viewerWrap.classList.remove('hidden');

            // Viewport tools
            if (toolsObjects) toolsObjects.classList.add('hidden');
            if (toolsLayouts) toolsLayouts.classList.remove('hidden');
            if (bambuToolbar) bambuToolbar.classList.remove('hidden');
            if (bambuInspector) bambuInspector.classList.add('hidden');

            // Right sidebar
            if (settingsForm) settingsForm.classList.add('hidden');
            if (settingsEmpty) settingsEmpty.classList.add('hidden');
            if (plateSettingsForm) plateSettingsForm.classList.remove('hidden');
            const st = document.getElementById('settings-title');
            if (st) st.textContent = 'Plate Configuration';

            // Topbar navigation buttons
            if (btnContinuePlates) btnContinuePlates.classList.add('hidden');
            if (btnReviewSubmit)   btnReviewSubmit.classList.remove('hidden');
            if (btnSubmitFinal)    btnSubmitFinal.classList.add('hidden');

            deactivatePickMode();
            if (transformControls) transformControls.detach();
            if (selectionBox) selectionBox.visible = false;

            // Run nesting with all copies included
            if (!currentNesting || !currentNesting.plates || currentNesting.plates.length === 0) {
                currentNesting = PlateNestEngine.nest(files);
                activePlateIndex = 0;
            }
            if (badgePlatesCount) badgePlatesCount.textContent = currentNesting.plates.length;

            renderBuildPlatesTree();
            renderLayout3DPlate(activePlateIndex);
            if (currentNesting.plates[activePlateIndex]) {
                populatePlateSettings(currentNesting.plates[activePlateIndex]);
                updateScopeBottomBar('plate', currentNesting.plates[activePlateIndex]);
            }
            setLayoutTool('translate');

            showToast(`📐 Step 2: ${currentNesting.plates.length} build plate(s) arranged`, 'info', 2000);
        } else if (stage === 'review') {
            if (files.size === 0) {
                showToast('Please add at least one 3D model first', 'warn');
                return;
            }

            if (stepBtnObjects) {
                stepBtnObjects.classList.remove('active');
                stepBtnObjects.classList.add('completed');
                if (checkObjects) checkObjects.style.display = 'inline-flex';
            }
            if (stepBtnPlates) {
                stepBtnPlates.classList.remove('active');
                stepBtnPlates.classList.add('completed');
                if (checkPlates) checkPlates.style.display = 'inline-flex';
            }
            if (stepBtnReview) stepBtnReview.classList.add('active');

            if (objectsSidebarView) objectsSidebarView.classList.add('hidden');
            if (layoutsSidebarView) layoutsSidebarView.classList.add('hidden');
            if (reviewStageView)    reviewStageView.classList.remove('hidden');
            if (viewerWrap)         viewerWrap.classList.add('hidden');

            // Viewport tools
            if (toolsObjects) toolsObjects.classList.add('hidden');
            if (toolsLayouts) toolsLayouts.classList.add('hidden');
            if (bambuToolbar) bambuToolbar.classList.add('hidden');
            if (bambuInspector) bambuInspector.classList.add('hidden');

            // Topbar navigation buttons
            if (btnContinuePlates) btnContinuePlates.classList.add('hidden');
            if (btnReviewSubmit)   btnReviewSubmit.classList.add('hidden');
            if (btnSubmitFinal)    btnSubmitFinal.classList.remove('hidden');

            if (!currentNesting || !currentNesting.plates || currentNesting.plates.length === 0) {
                currentNesting = PlateNestEngine.nest(files);
                activePlateIndex = 0;
            }

            renderReviewStage();
            showToast('📋 Step 3: Review & Submit Job Manifest', 'info', 2000);
        }
    }

    function switchMode(mode) {
        setWorkflowStage(mode);
    }

    function setLayoutTool(tool) {
        currentLayoutTool = tool; // 'translate' | 'rotate'
        if (toolLayoutMove) toolLayoutMove.classList.toggle('active', tool === 'translate');
        if (toolLayoutRotate) toolLayoutRotate.classList.toggle('active', tool === 'rotate');

        if (selectedLayoutMesh) {
            applyLayoutTransformMode(selectedLayoutMesh);
        } else {
            if (transformControls) transformControls.detach();
            updateCompassGizmo(null);
        }
    }

    function applyLayoutTransformMode(partGroup) {
        if (!partGroup) {
            if (transformControls) transformControls.detach();
            updateCompassGizmo(null);
            return;
        }
        if (currentLayoutTool === 'translate') {
            updateCompassGizmo(null);
            if (transformControls) {
                transformControls.attach(partGroup);
                transformControls.setMode('translate');
                transformControls.setSpace('world');
                transformControls.showX = true;
                transformControls.showY = false; // Lock on bed
                transformControls.showZ = true;
            }
        } else if (currentLayoutTool === 'rotate') {
            if (transformControls) transformControls.detach();
            updateCompassGizmo(partGroup);
        }
    }

    function selectLayoutPart(partGroup) {
        selectedLayoutMesh = partGroup;
        if (!partGroup) {
            if (transformControls) transformControls.detach();
            if (selectionBox) selectionBox.visible = false;
            updateCompassGizmo(null);
            if (currentNesting && currentNesting.plates[activePlateIndex]) {
                updateScopeBottomBar('plate', currentNesting.plates[activePlateIndex]);
            }
            return;
        }
        partGroup.position.y = 0; // Keep flat on bed
        if (selectionBox) {
            selectionBox.setFromObject(partGroup);
            selectionBox.visible = true;
        }
        applyLayoutTransformMode(partGroup);
        if (partGroup.userData && partGroup.userData.part) {
            updateScopeBottomBar('part', partGroup.userData.part);
        }
    }

    function updateCompassGizmo(partGroup) {
        if (!compassGizmo) return;
        if (!partGroup || currentMode !== 'layouts' || currentLayoutTool !== 'rotate') {
            compassGizmo.visible = false;
            if (compassTooltip) compassTooltip.classList.add('hidden');
            return;
        }

        const entry = partGroup.userData.entry;
        const b = entry && entry.geometry ? entry.geometry.bounds : { width: 50, depth: 50 };
        const r = Math.max(34, Math.hypot(b.width, b.depth) * 0.58 + 14);
        const d = compassGizmo.userData;
        d.currentRadius = r;

        // Position on plate right under the part
        compassGizmo.position.set(partGroup.position.x, 0.35, partGroup.position.z);
        compassGizmo.visible = true;

        // 1. Rebuild Blue Ring points
        const ringPts = [];
        for (let i = 0; i <= 128; i++) {
            const th = (i / 128) * Math.PI * 2;
            ringPts.push(new THREE.Vector3(r * Math.cos(th), 0, r * Math.sin(th)));
        }
        d.ringLine.geometry.dispose();
        d.ringLine.geometry = new THREE.BufferGeometry().setFromPoints(ringPts);

        // 2. Rebuild Protractor Ticks
        const tickPts = [];
        // 4 crosshair lines
        [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach(th => {
            tickPts.push(new THREE.Vector3(r * 0.18 * Math.cos(th), 0, r * 0.18 * Math.sin(th)));
            tickPts.push(new THREE.Vector3(r * Math.cos(th), 0, r * Math.sin(th)));
        });
        // Ticks every 5 degrees
        for (let deg = 0; deg < 360; deg += 5) {
            const th = (deg * Math.PI) / 180;
            let len = 2.5;
            if (deg % 45 === 0) len = 8;
            else if (deg % 15 === 0) len = 5;
            tickPts.push(new THREE.Vector3((r - len) * Math.cos(th), 0, (r - len) * Math.sin(th)));
            tickPts.push(new THREE.Vector3(r * Math.cos(th), 0, r * Math.sin(th)));
        }
        d.ticksLine.geometry.dispose();
        d.ticksLine.geometry = new THREE.BufferGeometry().setFromPoints(tickPts);

        // 3. Rebuild Hit Ring geometry
        d.ringHit.geometry.dispose();
        const hitRGeo = new THREE.RingGeometry(Math.max(1, r - 8), r + 8, 64);
        hitRGeo.rotateX(-Math.PI / 2);
        d.ringHit.geometry = hitRGeo;

        // 4. Update pointer and handle position based on current part rotation
        updateCompassHandleAngle(partGroup.rotation.y);
    }

    function updateCompassHandleAngle(rotY) {
        if (!compassGizmo || !compassGizmo.visible) return;
        const d = compassGizmo.userData;
        const r = d.currentRadius;

        // In Three.js, positive rotation around Y by angle theta turns +X towards -Z.
        // Thus on the bed plane (X, Z), the angle is phi = -rotY.
        // Handle position is at (r * cos(phi), 0, r * sin(phi)) = (r * cos(rotY), 0, -r * sin(rotY)).
        const cosY = Math.cos(rotY);
        const sinY = Math.sin(rotY);
        const hx = r * cosY;
        const hz = -r * sinY;

        // Pointer line from center to handle
        const ptrPts = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(hx, 0, hz)
        ];
        d.pointerLine.geometry.dispose();
        d.pointerLine.geometry = new THREE.BufferGeometry().setFromPoints(ptrPts);

        // Handle group on perimeter, tangent to circle
        d.handleGroup.position.set(hx, 0, hz);
        d.handleGroup.rotation.y = rotY;
    }

    function checkLayoutPlateCollisions(plateIdx) {
        if (!currentNesting || !currentNesting.plates[plateIdx]) return;
        const plate = currentNesting.plates[plateIdx];
        const halfBed = PLATE_SIZE / 2;
        let outOfBounds = false;
        let collision = false;

        for (let i = 0; i < plate.parts.length; i++) {
            const p1 = plate.parts[i];
            const cos1 = Math.abs(Math.cos(p1.rotY || 0));
            const sin1 = Math.abs(Math.sin(p1.rotY || 0));
            const effW1 = cos1 * p1.width + sin1 * p1.depth;
            const effD1 = sin1 * p1.width + cos1 * p1.depth;
            const halfW1 = effW1 / 2;
            const halfD1 = effD1 / 2;

            if (p1.posX - halfW1 < -halfBed || p1.posX + halfW1 > halfBed ||
                p1.posZ - halfD1 < -halfBed || p1.posZ + halfD1 > halfBed) {
                outOfBounds = true;
            }

            for (let j = i + 1; j < plate.parts.length; j++) {
                const p2 = plate.parts[j];
                const cos2 = Math.abs(Math.cos(p2.rotY || 0));
                const sin2 = Math.abs(Math.sin(p2.rotY || 0));
                const effW2 = cos2 * p2.width + sin2 * p2.depth;
                const effD2 = sin2 * p2.width + cos2 * p2.depth;
                const halfW2 = effW2 / 2;
                const halfD2 = effD2 / 2;

                if (Math.abs(p1.posX - p2.posX) < (halfW1 + halfW2 + 1) &&
                    Math.abs(p1.posZ - p2.posZ) < (halfD1 + halfD2 + 1)) {
                    collision = true;
                }
            }
        }

        if (plateFitBadge) {
            if (outOfBounds) {
                plateFitBadge.textContent = '⚠️ Part off bed edge!';
                plateFitBadge.className = 'plate-badge fit-warn';
            } else if (collision) {
                plateFitBadge.textContent = '⚠️ Parts overlap!';
                plateFitBadge.className = 'plate-badge fit-warn';
            } else {
                plateFitBadge.textContent = `Plate ${plate.id} · Bambu 256×256 mm (Fits)`;
                plateFitBadge.className = 'plate-badge';
            }
        }
    }

    function reNestCurrentPlate() {
        if (!currentNesting || !currentNesting.plates[activePlateIndex]) return;
        const plate = currentNesting.plates[activePlateIndex];
        PlateNestEngine.reNestPlate(plate);
        renderLayout3DPlate(activePlateIndex);
        renderLayoutSidebar();
        populatePlateSettings(plate);
        showToast(`✨ Auto-nested Plate ${plate.id} with 10mm clearance`, 'success', 2500);
    }

    function renderLayout3DPlate(idx) {
        if (!scene) initViewer();
        if (viewerEmpty) viewerEmpty.style.display = 'none';

        if (transformControls) transformControls.detach();
        if (selectionBox) selectionBox.visible = false;
        selectedLayoutMesh = null;

        // Clear previous plate group
        if (layoutPlateGroup) {
            scene.remove(layoutPlateGroup);
            while (layoutPlateGroup.children.length > 0) {
                const child = layoutPlateGroup.children[0];
                layoutPlateGroup.remove(child);
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            }
        }
        layoutPlateGroup = new THREE.Group();
        layoutPlateGroup.name = 'layoutPlateGroup';
        scene.add(layoutPlateGroup);

        // Hide individual object meshes
        files.forEach(f => {
            if (f.mesh) f.mesh.visible = false;
        });

        if (!currentNesting || !currentNesting.plates.length) return;
        const plate = currentNesting.plates[idx];
        if (!plate) return;

        update3DPlateLabel(plate.customName || ('Plate ' + plate.id));

        plate.parts.forEach((p, pIdx) => {
            const entry = p.entry;
            if (!entry || !entry.triangles) return;

            const geo = buildGeometryFromTriangles(entry.triangles);
            const mat = new THREE.MeshStandardMaterial({
                roughness: 0.55,
                metalness: 0.05,
                side: THREE.DoubleSide
            });
            mat.color.set(entry.config.color);

            const partGroup = new THREE.Group();
            partGroup.name = 'layoutPartGroup_' + pIdx;
            partGroup.position.set(p.posX, 0, p.posZ);
            partGroup.rotation.y = p.rotY || 0;
            partGroup.userData = {
                isPlatePart: true,
                plateIndex: idx,
                partIndex: pIdx,
                part: p,
                entry: entry
            };

            const m = new THREE.Mesh(geo, mat);
            m.rotation.x = -Math.PI / 2;
            m.position.set(0, entry.geometry.bounds.height / 2, 0);
            m.userData = {
                isPlateChildMesh: true,
                partGroup: partGroup,
                part: p,
                entry: entry
            };
            partGroup.add(m);
            layoutPlateGroup.add(partGroup);
        });

        if (layoutPlateGroup.children.length > 0) {
            selectLayoutPart(layoutPlateGroup.children[0]);
        }

        checkLayoutPlateCollisions(idx);
        controls.target.set(0, 0, 0);
        viewHome();
    }

    function recomputePlateMetrics(plate) {
        if (!plate) return;
        let plateWeight = 0, plateCost = 0, maxPrepTime = 0, totalExtrusionMinutes = 0, totalFootprint = 0;
        for (const p of plate.parts) {
            const c = p.entry.config;
            c.material = plate.material;
            c.layerHeight = plate.layerHeight;
            c.shells.wallLoops = plate.wallLoops !== undefined ? plate.wallLoops : 2;
            c.infillDensity = plate.infill !== undefined ? plate.infill : 30;
            c.enableSupports = plate.supports !== undefined ? plate.supports : true;
            p.entry.estimates = PrintEstimator.estimate(p.entry.geometry, c);

            const e = p.entry.estimates;
            plateWeight += e.weightGrams;
            plateCost += (e.weightGrams / 1000) * c.pricePerKg;
            const prep = (c.prepTimeMinutes !== undefined ? c.prepTimeMinutes : 6.0);
            if (prep > maxPrepTime) maxPrepTime = prep;
            const partTotalMins = (e.printTimeHours * 60) + e.printTimeMinutes;
            totalExtrusionMinutes += Math.max(0, partTotalMins - prep);
            totalFootprint += (p.width * p.depth);
        }
        const plateTotalMins = plate.parts.length > 0 ? (maxPrepTime + totalExtrusionMinutes) : 0;
        plate.totalTimeMinutes = Math.round(plateTotalMins % 60);
        plate.totalTimeHours = Math.floor(plateTotalMins / 60);
        plate.totalWeightGrams = plateWeight;
        plate.totalCost = plateCost;
        plate.bedOccupancyPct = Math.min(100, Math.round((totalFootprint / (PlateNestEngine.USABLE_WIDTH * PlateNestEngine.USABLE_DEPTH)) * 100));
    }

    function recomputeAllNestingTotals() {
        if (!currentNesting || !currentNesting.plates) return;
        let grandMins = 0, grandWeight = 0, grandCost = 0;
        currentNesting.plates.forEach(pl => {
            recomputePlateMetrics(pl);
            ThumbnailRenderer.capturePlate(pl);
            grandMins += (pl.totalTimeHours * 60 + pl.totalTimeMinutes);
            grandWeight += pl.totalWeightGrams;
            grandCost += pl.totalCost;
        });
        currentNesting.grandTotalHours = Math.floor(grandMins / 60);
        currentNesting.grandTotalMinutes = Math.round(grandMins % 60);
        currentNesting.grandTotalWeight = grandWeight;
        currentNesting.grandTotalCost = grandCost;
        if (badgePlatesCount) badgePlatesCount.textContent = currentNesting.plates.length;
    }

    function movePartToPlate(srcPlateIdx, partIdx, dstPlateIdx) {
        if (!currentNesting || !currentNesting.plates[srcPlateIdx]) return;
        const srcPlate = currentNesting.plates[srcPlateIdx];
        if (partIdx < 0 || partIdx >= srcPlate.parts.length) return;

        const [part] = srcPlate.parts.splice(partIdx, 1);

        // Target plate determination
        let targetPlate;
        if (dstPlateIdx === 'new' || dstPlateIdx >= currentNesting.plates.length) {
            const newId = currentNesting.plates.length + 1;
            targetPlate = {
                id: newId,
                printer: srcPlate.printer || 'bambu_x1c',
                material: part.entry.config.material || srcPlate.material || 'PLA',
                layerHeight: part.entry.config.layerHeight || srcPlate.layerHeight || 0.20,
                wallLoops: srcPlate.wallLoops !== undefined ? srcPlate.wallLoops : 2,
                infill: srcPlate.infill !== undefined ? srcPlate.infill : 30,
                supports: srcPlate.supports !== undefined ? srcPlate.supports : true,
                reason: 'Custom Plate',
                parts: [],
                totalWeightGrams: 0,
                totalTimeHours: 0,
                totalTimeMinutes: 0,
                totalCost: 0,
                bedOccupancyPct: 0
            };
            currentNesting.plates.push(targetPlate);
            dstPlateIdx = currentNesting.plates.length - 1;
        } else {
            targetPlate = currentNesting.plates[dstPlateIdx];
        }

        // Place on target plate
        const placePos = PlateNestEngine.findPlacement(targetPlate.parts, part.width, part.depth);
        if (placePos) {
            part.posX = placePos.x;
            part.posZ = placePos.z;
        } else {
            part.posX = (targetPlate.parts.length * 15) % 80;
            part.posZ = (targetPlate.parts.length * 15) % 80;
        }
        targetPlate.parts.push(part);

        // Remove empty source plate
        if (srcPlate.parts.length === 0) {
            currentNesting.plates.splice(srcPlateIdx, 1);
            currentNesting.plates.forEach((p, i) => { p.id = i + 1; });
            if (dstPlateIdx > srcPlateIdx) {
                dstPlateIdx--;
            }
            activePlateIndex = Math.min(dstPlateIdx, currentNesting.plates.length - 1);
        } else {
            activePlateIndex = dstPlateIdx;
        }

        recomputeAllNestingTotals();
        renderLayoutSidebar();
        renderLayout3DPlate(activePlateIndex);
        populatePlateSettings(currentNesting.plates[activePlateIndex]);

        // Select the moved mesh
        if (layoutPlateGroup && layoutPlateGroup.children.length > 0) {
            const movedMesh = layoutPlateGroup.children.find(m => m.userData && m.userData.part === part);
            if (movedMesh) selectLayoutPart(movedMesh);
        }

        showToast(`📦 Moved "${part.entry.name}" to Plate ${targetPlate.id}`, 'success', 3000);
    }

    function createNewPlate() {
        if (!currentNesting) return;
        const currentPlate = currentNesting.plates[activePlateIndex] || currentNesting.plates[0] || {};
        const newId = currentNesting.plates.length + 1;
        const newPlate = {
            id: newId,
            printer: currentPlate.printer || 'bambu_x1c',
            material: currentPlate.material || 'PLA',
            layerHeight: currentPlate.layerHeight || 0.20,
            wallLoops: currentPlate.wallLoops !== undefined ? currentPlate.wallLoops : 2,
            infill: currentPlate.infill !== undefined ? currentPlate.infill : 30,
            supports: currentPlate.supports !== undefined ? currentPlate.supports : true,
            reason: 'Custom Plate',
            parts: [],
            totalWeightGrams: 0,
            totalTimeHours: 0,
            totalTimeMinutes: 0,
            totalCost: 0,
            bedOccupancyPct: 0
        };
        currentNesting.plates.push(newPlate);
        activePlateIndex = currentNesting.plates.length - 1;
        if (badgePlatesCount) badgePlatesCount.textContent = currentNesting.plates.length;
        recomputeAllNestingTotals();
        renderLayoutSidebar();
        renderLayout3DPlate(activePlateIndex);
        populatePlateSettings(currentNesting.plates[activePlateIndex]);
        showToast(`✨ Created Plate ${newPlate.id}`, 'success', 2500);
    }

    function deletePlate(plateIdx) {
        if (!currentNesting || currentNesting.plates.length <= 1) return;
        const [removed] = currentNesting.plates.splice(plateIdx, 1);
        currentNesting.plates.forEach((p, i) => { p.id = i + 1; });
        activePlateIndex = Math.max(0, Math.min(activePlateIndex, currentNesting.plates.length - 1));
        if (badgePlatesCount) badgePlatesCount.textContent = currentNesting.plates.length;
        recomputeAllNestingTotals();
        renderLayoutSidebar();
        renderLayout3DPlate(activePlateIndex);
        populatePlateSettings(currentNesting.plates[activePlateIndex]);
        showToast(`🗑️ Deleted Plate ${removed.id}`, 'info', 2000);
    }

    function showLayoutContextMenu(x, y, partIndex, partName) {
        if (!layoutContextMenu || !currentNesting || !currentNesting.plates.length) return;
        const currentPlate = currentNesting.plates[activePlateIndex];
        if (!currentPlate || !currentPlate.parts[partIndex]) return;

        if (ctxPartTitle) ctxPartTitle.textContent = partName || currentPlate.parts[partIndex].entry.name || 'Selected Part';
        if (ctxPlateList) {
            ctxPlateList.innerHTML = '';
            currentNesting.plates.forEach((plate, pIdx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ctx-item' + (pIdx === activePlateIndex ? ' current' : '');
                btn.innerHTML = `
                    <span>Plate ${plate.id} (${plate.material})</span>
                    ${pIdx === activePlateIndex ? '<span style="font-size:0.7rem;">(Current)</span>' : '<span style="font-size:0.7rem;color:var(--c-muted);">' + plate.parts.length + (plate.parts.length === 1 ? ' part' : ' parts') + '</span>'}
                `;
                if (pIdx !== activePlateIndex) {
                    btn.addEventListener('click', () => {
                        hideLayoutContextMenu();
                        movePartToPlate(activePlateIndex, partIndex, pIdx);
                    });
                }
                ctxPlateList.appendChild(btn);
            });

            // "+ Move to New Plate"
            const newPlateBtn = document.createElement('button');
            newPlateBtn.type = 'button';
            newPlateBtn.className = 'ctx-item new-plate';
            newPlateBtn.innerHTML = `<span>＋ Move to New Plate</span>`;
            newPlateBtn.addEventListener('click', () => {
                hideLayoutContextMenu();
                movePartToPlate(activePlateIndex, partIndex, 'new');
            });
            ctxPlateList.appendChild(newPlateBtn);
        }

        // Position menu
        layoutContextMenu.classList.remove('hidden');
        const menuWidth = 200;
        const menuHeight = layoutContextMenu.offsetHeight || 160;
        const posX = Math.min(x, window.innerWidth - menuWidth - 12);
        const posY = Math.min(y, window.innerHeight - menuHeight - 12);
        layoutContextMenu.style.left = `${Math.max(12, posX)}px`;
        layoutContextMenu.style.top = `${Math.max(12, posY)}px`;
    }

    function hideLayoutContextMenu() {
        if (layoutContextMenu) layoutContextMenu.classList.add('hidden');
    }

    // ── Build Plates Tree Renderer (Single Source of Truth) ───────────────────
    function renderBuildPlatesTree() {
        if (!currentNesting || !currentNesting.plates.length) return;

        let totalCopiesCount = 0;
        files.forEach(f => {
            totalCopiesCount += Math.max(1, parseInt(f.quantity, 10) || 1);
        });

        // Persistent Job Summary
        if (sideTotalPlates) sideTotalPlates.textContent = `${currentNesting.plates.length} ${currentNesting.plates.length === 1 ? 'plate' : 'plates'}`;
        if (sideTotalParts)  sideTotalParts.textContent  = totalCopiesCount;
        if (sideTotalTime)   sideTotalTime.textContent   = PrintEstimator.formatTime(currentNesting.grandTotalHours, currentNesting.grandTotalMinutes);
        if (sideTotalWeight) sideTotalWeight.textContent = `${currentNesting.grandTotalWeight.toFixed(1)} g`;
        if (sideTotalCost)   sideTotalCost.textContent   = `₹ ${currentNesting.grandTotalCost.toFixed(2)}`;

        const treeCountEl = document.getElementById('tree-plates-count');
        if (treeCountEl) treeCountEl.textContent = currentNesting.plates.length;

        // Render Tree Cards
        if (buildPlatesTree) {
            buildPlatesTree.innerHTML = '';
            currentNesting.plates.forEach((plate, idx) => {
                const isCurrent = (idx === activePlateIndex);
                const card = document.createElement('div');
                card.className = 'tree-plate-card' + (isCurrent ? ' active' : '');
                const plateName = plate.customName || `Plate ${plate.id}`;

                // Status checkmark or warning
                const statusBadge = plate.bedOccupancyPct > 90
                    ? `<span class="tree-status-warn" title="Bed occupancy exceeds 90%">⚠️</span>`
                    : `<span class="tree-status-check" title="Plate ready">✓</span>`;

                if (!plate.thumbnailUrl) {
                    ThumbnailRenderer.capturePlate(plate);
                }

                const isExpanded = (plateTrayMode === 'expanded') || expandedPlateIds.has(plate.id);
                const timeStr = PrintEstimator.formatTime(plate.totalTimeHours, plate.totalTimeMinutes);
                const weightStr = `${plate.totalWeightGrams.toFixed(1)}g`;
                const thumbHtml = plate.thumbnailUrl
                    ? `<img class="tree-plate-thumb-img" src="${plate.thumbnailUrl}" alt="${escapeHtml(plateName)}">`
                    : `<div class="tree-plate-thumb-ph">🔲</div>`;

                card.innerHTML = `
                    <div class="tree-plate-header" data-plate-idx="${idx}">
                        <div class="tree-plate-thumb-wrap" title="Plate ${plate.id} Layout Preview">
                            ${thumbHtml}
                        </div>
                        <div class="tree-plate-info">
                            <div class="tree-plate-title-line">
                                <div class="tree-plate-left-title">
                                    <span class="tree-plate-name" title="${escapeHtml(plateName)}">${escapeHtml(plateName)}</span>
                                    ${statusBadge}
                                </div>
                                <div class="tree-plate-badges">
                                    <span class="tree-occupancy-badge ${plate.bedOccupancyPct > 90 ? 'danger' : plate.bedOccupancyPct > 75 ? 'warning' : ''}">${plate.bedOccupancyPct}%</span>
                                    <span class="tree-mat-badge">${plate.material}</span>
                                    <span class="tree-plate-arrow" title="${isExpanded ? 'Collapse parts' : 'Expand parts'}">${isExpanded ? '▴' : '▾'}</span>
                                </div>
                            </div>
                            <div class="tree-plate-stats-line">
                                <span>${plate.parts.length} part${plate.parts.length === 1 ? '' : 's'}</span> ·
                                <span>${timeStr}</span> ·
                                <span>${weightStr}</span>
                            </div>
                        </div>
                    </div>
                    <div class="tree-plate-body ${isExpanded ? '' : 'collapsed'}"></div>
                `;

                const header = card.querySelector('.tree-plate-header');
                const body = card.querySelector('.tree-plate-body');

                const treePlateNameEl = card.querySelector('.tree-plate-name');
                if (treePlateNameEl) {
                    treePlateNameEl.addEventListener('dblclick', (ev) => {
                        ev.stopPropagation();
                        const curName = plate.customName || `Plate ${plate.id}`;
                        const inp = document.createElement('input');
                        inp.type = 'text';
                        inp.className = 'tree-plate-name-input';
                        inp.value = curName;
                        treePlateNameEl.replaceWith(inp);
                        inp.focus();
                        inp.select();

                        let committed = false;
                        const commit = () => {
                            if (committed) return;
                            committed = true;
                            const val = inp.value.trim();
                            if (val && val !== curName) {
                                plate.customName = val;
                                if (idx === activePlateIndex) {
                                    if (plateNameInput) plateNameInput.value = val;
                                    update3DPlateLabel(val);
                                }
                                showToast(`✏️ Renamed plate to "${val}"`, 'info', 2000);
                            }
                            renderBuildPlatesTree();
                        };
                        inp.addEventListener('blur', commit);
                        inp.addEventListener('keydown', (ke) => {
                            if (ke.key === 'Enter') inp.blur();
                            else if (ke.key === 'Escape') { committed = true; renderBuildPlatesTree(); }
                        });
                    });
                }

                // Header click toggles expand/collapse and activates plate
                header.addEventListener('click', (ev) => {
                    if (ev && ev.target && ev.target.closest('.tree-plate-name-input')) return;
                    if (activePlateIndex !== idx) {
                        activePlateIndex = idx;
                        renderLayout3DPlate(activePlateIndex);
                        populatePlateSettings(currentNesting.plates[activePlateIndex]);
                        updateScopeBottomBar('plate', currentNesting.plates[activePlateIndex]);
                    }
                    if (expandedPlateIds.has(plate.id)) {
                        expandedPlateIds.delete(plate.id);
                    } else {
                        expandedPlateIds.add(plate.id);
                    }
                    renderBuildPlatesTree();
                });

                // Drag & drop parts onto plate card
                card.addEventListener('dragover', (ev) => {
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = 'move';
                    card.classList.add('drag-over');
                });
                card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
                card.addEventListener('drop', (ev) => {
                    ev.preventDefault();
                    card.classList.remove('drag-over');
                    try {
                        const raw = ev.dataTransfer.getData('text/plain');
                        if (!raw) return;
                        const data = JSON.parse(raw);
                        if (data && data.partIndex !== undefined && data.sourcePlateIndex !== undefined) {
                            if (data.sourcePlateIndex !== idx) {
                                movePartToPlate(data.sourcePlateIndex, data.partIndex, idx);
                            }
                        }
                    } catch (err) {
                        console.error('Drop error:', err);
                    }
                });

                // Populate parts in plate body (only if expanded or plate has parts)
                if (plate.parts.length === 0) {
                    const emptyHint = document.createElement('div');
                    emptyHint.className = 'tree-empty-plate';
                    emptyHint.textContent = 'Empty plate. Drag parts here or use Move ▾';
                    body.appendChild(emptyHint);
                } else {
                    const partCounts = new Map();
                    plate.parts.forEach(p => {
                        const cnt = partCounts.get(p.entry) || 0;
                        partCounts.set(p.entry, cnt + 1);
                    });

                    partCounts.forEach((count, entry) => {
                        const row = document.createElement('div');
                        row.className = 'tree-part-item';
                        row.draggable = true;

                        const partThumbHtml = entry.thumbnailUrl
                            ? `<div class="tree-part-thumb-mini"><img src="${entry.thumbnailUrl}" alt="${escapeHtml(entry.name)}"></div>`
                            : `<div class="tree-part-color" style="background:${entry.config ? entry.config.color : '#00ae42'}"></div>`;

                        row.innerHTML = `
                            <div class="tree-part-left">
                                <div class="tree-part-drag-handle" title="Drag to reorder or move to another plate">
                                    <svg viewBox="0 0 8 14" width="8" height="14" fill="currentColor">
                                        <circle cx="2" cy="2" r="1.1"/>
                                        <circle cx="2" cy="7" r="1.1"/>
                                        <circle cx="2" cy="12" r="1.1"/>
                                        <circle cx="6" cy="2" r="1.1"/>
                                        <circle cx="6" cy="7" r="1.1"/>
                                        <circle cx="6" cy="12" r="1.1"/>
                                    </svg>
                                </div>
                                ${partThumbHtml}
                                <span class="tree-part-name" title="${escapeHtml(entry.name)} (Double-click to rename)">${escapeHtml(entry.name)}</span>
                            </div>
                            <div class="tree-part-right">
                                <span class="tree-part-qty">×${count}</span>
                                <button type="button" class="side-part-move-btn" title="Move to another plate">
                                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M2.5 5.5h8.5m0 0L8 3m3 2.5L8 8"/>
                                        <path d="M13.5 10.5H5m0 0l3 2.5m-3-2.5l3-2.5"/>
                                    </svg>
                                </button>
                            </div>
                        `;

                        const treePartNameEl = row.querySelector('.tree-part-name');
                        if (treePartNameEl) {
                            treePartNameEl.addEventListener('dblclick', (ev) => {
                                ev.stopPropagation();
                                const curName = entry.name;
                                const inp = document.createElement('input');
                                inp.type = 'text';
                                inp.className = 'tree-part-name-input';
                                inp.value = curName;
                                treePartNameEl.replaceWith(inp);
                                inp.focus();
                                inp.select();

                                let committed = false;
                                const commit = () => {
                                    if (committed) return;
                                    committed = true;
                                    const val = inp.value.trim();
                                    if (val && val !== curName) {
                                        renameEntry(entry, val);
                                        showToast(`✏️ Renamed object to "${val}"`, 'info', 2000);
                                    } else {
                                        renderBuildPlatesTree();
                                    }
                                };
                                inp.addEventListener('blur', commit);
                                inp.addEventListener('keydown', (e) => {
                                    if (e.key === 'Enter') {
                                        commit();
                                    } else if (e.key === 'Escape') {
                                        committed = true;
                                        renderBuildPlatesTree();
                                    }
                                    e.stopPropagation();
                                });
                                inp.addEventListener('click', (e) => e.stopPropagation());
                            });
                        }

                        const getPartIndex = () => plate.parts.findIndex(p => p.entry === entry);

                        // Drag support
                        row.addEventListener('dragstart', (ev) => {
                            const pIdx = getPartIndex();
                            if (pIdx === -1) return;
                            row.classList.add('dragging');
                            ev.dataTransfer.effectAllowed = 'move';
                            ev.dataTransfer.setData('text/plain', JSON.stringify({
                                sourcePlateIndex: idx,
                                partIndex: pIdx
                            }));
                        });
                        row.addEventListener('dragend', () => row.classList.remove('dragging'));

                        // Move button dropdown
                        const moveBtn = row.querySelector('.side-part-move-btn');
                        if (moveBtn) {
                            moveBtn.addEventListener('click', (ev) => {
                                ev.stopPropagation();
                                const pIdx = getPartIndex();
                                if (pIdx === -1) return;
                                const rect = moveBtn.getBoundingClientRect();
                                showLayoutContextMenu(rect.left, rect.bottom + 4, pIdx, entry.name);
                            });
                        }

                        // Right-click context menu
                        row.addEventListener('contextmenu', (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            const pIdx = getPartIndex();
                            if (pIdx === -1) return;
                            showLayoutContextMenu(ev.clientX, ev.clientY, pIdx, entry.name);
                        });

                        // Row click selects part in 3D
                        row.addEventListener('click', () => {
                            if (activePlateIndex !== idx) {
                                activePlateIndex = idx;
                                renderBuildPlatesTree();
                                renderLayout3DPlate(activePlateIndex);
                                populatePlateSettings(currentNesting.plates[activePlateIndex]);
                            }
                            if (layoutPlateGroup) {
                                const matchingMesh = layoutPlateGroup.children.find(m => m.userData && m.userData.entry === entry);
                                if (matchingMesh) selectLayoutPart(matchingMesh);
                            }
                        });

                        body.appendChild(row);
                    });
                }

                buildPlatesTree.appendChild(card);
            });
        }

        // Needs Review Quarantine Rendering
        if (needsReviewSection) {
            const nrItems = currentNesting.needsReview || [];
            if (nrItems.length > 0) {
                needsReviewSection.classList.remove('hidden');
                if (needsReviewCount) needsReviewCount.textContent = nrItems.length;
                if (needsReviewList) {
                    needsReviewList.innerHTML = '';
                    nrItems.forEach(item => {
                        const nrCard = document.createElement('div');
                        nrCard.className = 'needs-review-card';
                        nrCard.innerHTML = `
                            <div class="nr-card-top">
                                <span class="nr-warn">⚠️</span>
                                <span class="nr-name" title="${escapeHtml(item.entry.name)}">${escapeHtml(item.entry.name)}</span>
                                <span class="nr-qty">×${item.quantity || 1}</span>
                            </div>
                            <div class="nr-reason">${escapeHtml(item.reason)}</div>
                        `;
                        needsReviewList.appendChild(nrCard);
                    });
                }
            } else {
                needsReviewSection.classList.add('hidden');
            }
        }
    }

    function renderLayoutSidebar() {
        renderBuildPlatesTree();
    }

    // ── Review & Submit Stage Renderer ───────────────────────────────────────
    function renderReviewStage() {
        if (!currentNesting || !currentNesting.plates) return;

        let totalCopiesCount = 0;
        files.forEach(f => {
            totalCopiesCount += Math.max(1, parseInt(f.quantity, 10) || 1);
        });

        if (revTotalParts) revTotalParts.textContent = totalCopiesCount;
        if (revTotalPlates) revTotalPlates.textContent = currentNesting.plates.length;
        if (revTotalTime) revTotalTime.textContent = PrintEstimator.formatTime(currentNesting.grandTotalHours, currentNesting.grandTotalMinutes);
        if (revTotalWeight) revTotalWeight.textContent = `${currentNesting.grandTotalWeight.toFixed(1)} g`;
        if (revTotalCost) revTotalCost.textContent = `₹ ${currentNesting.grandTotalCost.toFixed(2)}`;

        // Unassigned alert
        if (revAlertUnassigned) {
            if (currentNesting.needsReview && currentNesting.needsReview.length > 0) {
                revAlertUnassigned.classList.remove('hidden');
                const alertText = revAlertUnassigned.querySelector('.rev-alert-text');
                if (alertText) {
                    alertText.textContent = `${currentNesting.needsReview.length} item(s) in quarantine require review (cannot fit standard bed).`;
                }
            } else {
                revAlertUnassigned.classList.add('hidden');
            }
        }

        // Plate audit cards
        if (reviewPlatesGrid) {
            reviewPlatesGrid.innerHTML = '';
            currentNesting.plates.forEach((plate, idx) => {
                const card = document.createElement('div');
                card.className = 'rev-plate-card';

                const exportName = generateDefaultPlateName(plate);
                const printerLabel = (plate.printer === 'bambu_a1' ? 'Bambu A1' :
                                      plate.printer === 'prusa_mk4' ? 'Prusa MK4' :
                                      plate.printer === 'ender_3' ? 'Creality Ender 3' : 'Bambu X1C / P1S');

                const partRows = (plate.parts || []).map(p => `
                    <div class="rev-card-part-row">
                        <span class="rev-part-dot" style="background:${p.entry.config.color}"></span>
                        <span class="rev-part-title">${escapeHtml(p.entry.name)}</span>
                        <span class="rev-part-dim">${Math.round(p.width)}×${Math.round(p.depth)}×${Math.round(p.height)}mm</span>
                    </div>
                `).join('');

                card.innerHTML = `
                    <div class="rev-card-header">
                        <div class="rev-card-title-group">
                            <span class="rev-card-badge-num">Plate ${plate.id}</span>
                            <span class="rev-card-title">${escapeHtml(plate.customName || ('Plate ' + plate.id))}</span>
                        </div>
                        <span class="rev-card-mat-badge">${plate.material}</span>
                    </div>
                    <div class="rev-card-meta-bar">
                        <span>${printerLabel}</span> · <span>${plate.layerHeight}mm layer</span> · <span>${plate.infill}% infill</span>
                    </div>
                    <div class="rev-card-gauge-box">
                        <div class="rev-gauge-label-row">
                            <span>Bed Occupancy</span>
                            <span>${plate.bedOccupancyPct}%</span>
                        </div>
                        <div class="bed-gauge-track">
                            <div class="bed-gauge-fill ${plate.bedOccupancyPct > 90 ? 'danger' : plate.bedOccupancyPct > 75 ? 'warning' : ''}" style="width: ${plate.bedOccupancyPct}%"></div>
                        </div>
                    </div>
                    <div class="rev-card-stats-grid">
                        <div class="rev-c-stat">
                            <span class="rc-label">Parts</span>
                            <span class="rc-val">${plate.parts.length}</span>
                        </div>
                        <div class="rev-c-stat">
                            <span class="rc-label">Print Time</span>
                            <span class="rc-val">${PrintEstimator.formatTime(plate.totalTimeHours, plate.totalTimeMinutes)}</span>
                        </div>
                        <div class="rev-c-stat">
                            <span class="rc-label">Filament</span>
                            <span class="rc-val">${plate.totalWeightGrams.toFixed(1)}g</span>
                        </div>
                        <div class="rev-c-stat">
                            <span class="rc-label">Est. Cost</span>
                            <span class="rc-val">₹${plate.totalCost.toFixed(2)}</span>
                        </div>
                    </div>
                    <div class="rev-card-parts-manifest">
                        <div class="rev-manifest-header">Plate Manifest:</div>
                        ${partRows || '<div style="color:var(--c-muted);font-size:0.75rem;">Empty plate</div>'}
                    </div>
                    <div class="rev-card-footer">
                        <div class="rev-export-filename" title="${exportName}">📁 ${exportName}</div>
                        <div class="rev-card-actions">
                            <button type="button" class="btn-subtle rev-btn-inspect" data-plate-idx="${idx}">Inspect in 3D</button>
                            <button type="button" class="btn-subtle rev-btn-export" data-plate-idx="${idx}">Export .3MF</button>
                        </div>
                    </div>
                `;

                // Wire inspect button
                card.querySelector('.rev-btn-inspect').addEventListener('click', () => {
                    activePlateIndex = idx;
                    setWorkflowStage('plates');
                });

                // Wire export button
                card.querySelector('.rev-btn-export').addEventListener('click', () => {
                    showToast(`💾 Exported "${exportName}" manifest package`, 'success', 3000);
                });

                reviewPlatesGrid.appendChild(card);
            });
        }

        updateScopeBottomBar('job', {
            partsCount: totalCopiesCount,
            platesCount: currentNesting.plates.length,
            totalTime: PrintEstimator.formatTime(currentNesting.grandTotalHours, currentNesting.grandTotalMinutes),
            totalWeight: `${currentNesting.grandTotalWeight.toFixed(1)} g`,
            totalCost: `₹ ${currentNesting.grandTotalCost.toFixed(2)}`
        });
    }

    // ── Plate Configuration & Inspector ──────────────────────────────────────
    function populatePlateSettings(plate) {
        if (!plate) return;
        if (settingsEmpty) settingsEmpty.classList.add('hidden');
        if (settingsForm) settingsForm.classList.add('hidden');
        if (plateSettingsForm) plateSettingsForm.classList.remove('hidden');

        const st = document.getElementById('settings-title');
        if (st) st.textContent = 'Configuration';

        const modernPlateTitle = document.getElementById('modern-plate-title');
        if (modernPlateTitle) {
            modernPlateTitle.textContent = plate.customName || `Plate ${plate.id}`;
        }

        // Plate Name input & export preview
        if (plateNameInput) {
            plateNameInput.value = plate.customName || `Plate ${plate.id}`;
        }
        updatePlateExportPreview(plate);

        // Bed occupancy gauge
        if (plateBedUsageText) {
            plateBedUsageText.textContent = `${plate.bedOccupancyPct || 0}% used`;
        }
        if (plateBedGaugeFill) {
            plateBedGaugeFill.style.width = `${plate.bedOccupancyPct || 0}%`;
            plateBedGaugeFill.className = 'bed-gauge-fill' + (plate.bedOccupancyPct > 90 ? ' danger' : plate.bedOccupancyPct > 75 ? ' warning' : '');
        }

        if (platePrinter) platePrinter.value = plate.printer || 'bambu_x1c';
        if (plateMaterial) plateMaterial.value = plate.material || 'PLA';
        if (plateLayerHeight) plateLayerHeight.value = plate.layerHeight || 0.20;
        if (plateWallLoops) plateWallLoops.value = plate.wallLoops !== undefined ? plate.wallLoops : 2;
        if (plateInfill) plateInfill.value = plate.infill !== undefined ? plate.infill : 20;

        const plateColor = document.getElementById('plate-color');
        if (plateColor) {
            const partColor = (plate.parts && plate.parts[0] && plate.parts[0].entry && plate.parts[0].entry.config && plate.parts[0].entry.config.color) 
                ? plate.parts[0].entry.config.color 
                : '#0d6efd';
            let matched = false;
            for (let opt of plateColor.options) {
                if (opt.value.toLowerCase() === partColor.toLowerCase()) {
                    plateColor.value = opt.value;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                let customOpt = plateColor.querySelector('option[data-custom="true"]');
                if (!customOpt) {
                    customOpt = document.createElement('option');
                    customOpt.setAttribute('data-custom', 'true');
                    plateColor.appendChild(customOpt);
                }
                customOpt.value = partColor;
                customOpt.textContent = 'Custom';
                plateColor.value = partColor;
            }
        }

        if (plateSupports) {
            if (plateSupports.tagName === 'SELECT') {
                plateSupports.value = plate.supports ? (plate.supportType || 'tree') : 'none';
            } else {
                plateSupports.checked = plate.supports !== undefined ? plate.supports : true;
            }
        }

        if (pmOccupancy) pmOccupancy.textContent = `${plate.bedOccupancyPct || 0}%`;
        if (pmParts) pmParts.textContent = plate.parts ? plate.parts.length : 0;
        if (pmWeight) pmWeight.textContent = `${(plate.totalWeightGrams || 0).toFixed(1)} g`;
        if (pmTime) pmTime.textContent = PrintEstimator.formatTime(plate.totalTimeHours || 0, plate.totalTimeMinutes || 0);
        if (pmCost) pmCost.textContent = `₹ ${(plate.totalCost || 0).toFixed(2)}`;

        if (plateNotes) plateNotes.value = plate.notes || '';

        // Delete button availability (only if > 1 plate)
        if (btnPlateDelete) {
            btnPlateDelete.style.display = (currentNesting && currentNesting.plates.length > 1) ? 'inline-flex' : 'none';
        }
    }

    function onPlateSettingChanged() {
        if (!currentNesting || !currentNesting.plates[activePlateIndex]) return;
        const plate = currentNesting.plates[activePlateIndex];

        if (plateMaterial) plate.material = plateMaterial.value;
        if (platePrinter)  plate.printer  = platePrinter.value;
        if (plateLayerHeight) plate.layerHeight = parseFloat(plateLayerHeight.value) || 0.2;
        if (plateWallLoops) plate.wallLoops = parseInt(plateWallLoops.value, 10) || 2;
        if (plateInfill) plate.infill = parseInt(plateInfill.value, 10) || 20;
        if (plateSupports) {
            if (plateSupports.tagName === 'SELECT') {
                plate.supports = (plateSupports.value !== 'none');
                plate.supportType = plateSupports.value;
            } else {
                plate.supports = plateSupports.checked;
            }
        }

        const plateColor = document.getElementById('plate-color');
        if (plateColor && plate.parts) {
            plate.parts.forEach(p => {
                if (p.entry && p.entry.config) {
                    p.entry.config.color = plateColor.value;
                }
            });
            renderLayout3DPlate(activePlateIndex);
        }

        if (plateNotes) plate.notes = plateNotes.value;

        recomputeAllNestingTotals();
        populatePlateSettings(plate);
        renderBuildPlatesTree();
    }

    function submitFromLayout() {
        if (!currentNesting || !currentNesting.plates.length) return;

        let totalCopiesCount = 0;
        files.forEach(f => {
            totalCopiesCount += Math.max(1, parseInt(f.quantity, 10) || 1);
        });

        const matCounts = {};
        files.forEach(f => {
            matCounts[f.config.material] = (matCounts[f.config.material] || 0) + (f.quantity || 1);
        });
        const matSummary = Object.entries(matCounts).map(([m, c]) => `${m} (${c})`).join(', ');

        openJobModal({
            isMulti: true,
            title: `${totalCopiesCount} parts across ${currentNesting.plates.length} build plate(s)`,
            timeStr: PrintEstimator.formatTime(currentNesting.grandTotalHours, currentNesting.grandTotalMinutes),
            matStr: matSummary,
            costStr: `₹ ${currentNesting.grandTotalCost.toFixed(2)}`
        });
    }

    // ── Job Submission Modal ──────────────────────────────────────────────────
    function openJobModal(entryOrMulti) {
        if (!jobModal) return;

        const sumName = document.getElementById('sum-filename');
        const sumTime = document.getElementById('sum-time');
        const sumMat  = document.getElementById('sum-material');
        const sumCost = document.getElementById('sum-cost');

        if (entryOrMulti && entryOrMulti.isMulti) {
            if (sumName) sumName.textContent = entryOrMulti.title;
            if (sumTime) sumTime.textContent = entryOrMulti.timeStr;
            if (sumMat)  sumMat.textContent  = entryOrMulti.matStr;
            if (sumCost) sumCost.textContent = entryOrMulti.costStr;
        } else if (entryOrMulti && entryOrMulti.config) {
            const entry = entryOrMulti;
            const j = entry.config.job;
            const e = entry.estimates, c = entry.config;

            if (sumName) sumName.textContent = entry.name;
            if (sumTime) sumTime.textContent = PrintEstimator.formatTime(e.printTimeHours, e.printTimeMinutes);
            if (sumMat)  sumMat.textContent  = `${c.material} (${c.infillDensity}% infill, ${c.shells.wallLoops} loops)`;
            if (sumCost) {
                const costVal = (e.weightGrams / 1000) * c.pricePerKg;
                sumCost.textContent = isNaN(costVal) ? '--' : `₹ ${costVal.toFixed(2)}`;
            }
        }

        const fProf = window._lastFusionProfile || {};
        const savedTeam = loadGlobalPref('team', '');
        const savedReq  = loadGlobalPref('requester', '');
        const savedProj = loadGlobalPref('project', '');
        const savedDate = loadGlobalPref('requiredDate', '');

        if (sTeam)      sTeam.value      = fProf.team || savedTeam || '';
        if (sRequester) sRequester.value = fProf.requester || savedReq || '';
        if (sProject)   sProject.value   = fProf.project || savedProj || '';
        if (sPriority)  sPriority.value  = 'Normal';
        if (sDate) {
            const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
            sDate.value = fProf.date || savedDate || tomorrowStr;
        }
        if (sNotes)     sNotes.value     = fProf.notes || (fProf.designName ? `Exported from Fusion 360 (${fProf.designName})` : '');

        jobModal.classList.remove('hidden');
    }

    function closeJobModal() {
        if (jobModal) jobModal.classList.add('hidden');
    }

    // 3-Step Linear Workflow Navigation & Action Listeners
    if (stepBtnObjects)       stepBtnObjects.addEventListener('click', () => setWorkflowStage('objects'));
    if (stepBtnPlates)        stepBtnPlates.addEventListener('click', () => setWorkflowStage('plates'));
    if (stepBtnReview)        stepBtnReview.addEventListener('click', () => setWorkflowStage('review'));

    if (btnProceedLayout)     btnProceedLayout.addEventListener('click', () => setWorkflowStage('plates'));
    if (btnContinuePlates)    btnContinuePlates.addEventListener('click', () => setWorkflowStage('plates'));
    if (btnReviewSubmit)      btnReviewSubmit.addEventListener('click', () => setWorkflowStage('review'));
    if (btnSubmitFinal)       btnSubmitFinal.addEventListener('click', submitFromLayout);

    if (btnRevBack)           btnRevBack.addEventListener('click', () => setWorkflowStage('plates'));
    if (btnRevSubmitJob)      btnRevSubmitJob.addEventListener('click', submitFromLayout);

    // Build Plates Tree Actions
    if (btnCreatePlateTop)    btnCreatePlateTop.addEventListener('click', createNewPlate);
    if (btnCreatePlateBottom) btnCreatePlateBottom.addEventListener('click', createNewPlate);

    // Plate Settings Form Identity & Actions
    if (sObjectName) {
        sObjectName.addEventListener('input', () => {
            if (_suppress || !selectedId) return;
            const entry = files.get(selectedId);
            if (!entry) return;
            const newName = sObjectName.value.trim();
            if (newName && newName !== entry.name) {
                entry.name = newName;
                if (entry.mesh) {
                    entry.mesh.name = newName;
                    if (entry.mesh.userData && entry.mesh.userData.entry) {
                        entry.mesh.userData.entry.name = newName;
                    }
                }
                const activeCardName = document.querySelector(`.file-card.active .file-card-name`);
                if (activeCardName) {
                    activeCardName.textContent = newName;
                    activeCardName.setAttribute('title', `${newName} (Double-click to rename)`);
                }
                updateDetails(entry);
                if (typeof renderBuildPlatesTree === 'function') renderBuildPlatesTree();
                if (typeof renderReviewManifest === 'function') renderReviewManifest();
            }
        });
        sObjectName.addEventListener('change', () => {
            if (!selectedId) return;
            renderFileList();
        });
    }

    if (plateNameInput) {
        plateNameInput.addEventListener('input', () => {
            if (currentNesting && currentNesting.plates[activePlateIndex]) {
                const currentPlate = currentNesting.plates[activePlateIndex];
                currentPlate.customName = plateNameInput.value.trim();
                update3DPlateLabel(currentPlate.customName || ('Plate ' + currentPlate.id));
                updatePlateExportPreview(currentPlate);
                renderBuildPlatesTree();
            }
        });
    }

    if (btnPlateAutoArrange) {
        btnPlateAutoArrange.addEventListener('click', () => {
            if (currentNesting && currentNesting.plates[activePlateIndex]) {
                PlateNestEngine.reNestPlate(currentNesting.plates[activePlateIndex]);
                recomputeAllNestingTotals();
                populatePlateSettings(currentNesting.plates[activePlateIndex]);
                renderBuildPlatesTree();
                renderLayout3DPlate(activePlateIndex);
                showToast(`✨ Auto-arranged Plate ${currentNesting.plates[activePlateIndex].id}`, 'success', 2000);
            }
        });
    }

    if (btnPlateDelete) {
        btnPlateDelete.addEventListener('click', () => {
            deletePlate(activePlateIndex);
        });
    }

    if (needsReviewHeader) {
        needsReviewHeader.addEventListener('click', () => {
            if (needsReviewList) {
                needsReviewList.classList.toggle('collapsed');
                const arrow = needsReviewHeader.querySelector('.needs-review-arrow');
                if (arrow) arrow.textContent = needsReviewList.classList.contains('collapsed') ? '▸' : '▾';
            }
        });
    }

    if (btnCloseLayoutModal) btnCloseLayoutModal.addEventListener('click', () => { if (layoutModal) layoutModal.classList.add('hidden'); });

    // Layout Tools & Direct Submit Listeners
    if (toolLayoutMove)       toolLayoutMove.addEventListener('click', () => setLayoutTool('translate'));
    if (toolLayoutRotate)     toolLayoutRotate.addEventListener('click', () => setLayoutTool('rotate'));
    if (toolLayoutNest)       toolLayoutNest.addEventListener('click', () => reNestCurrentPlate());
    if (btnSubmitPlateDirect) btnSubmitPlateDirect.addEventListener('click', submitFromLayout);

    const plateColor = document.getElementById('plate-color');
    [platePrinter, plateMaterial, plateColor, plateLayerHeight, plateWallLoops, plateInfill, plateSupports].forEach(el => {
        if (el) {
            el.addEventListener('input', onPlateSettingChanged);
            el.addEventListener('change', onPlateSettingChanged);
        }
    });

    if (plateNotes) {
        plateNotes.addEventListener('input', () => {
            if (currentNesting && currentNesting.plates[activePlateIndex]) {
                currentNesting.plates[activePlateIndex].notes = plateNotes.value;
            }
        });
    }

    // ── Modern Card Title Inline Editing (Object & Plate) ──
    const modernPlateTitle = document.getElementById('modern-plate-title');
    const btnEditPlateName = document.getElementById('btn-edit-plate-name');
    if (modernPlateTitle && plateNameInput) {
        const startEditPlateName = () => {
            modernPlateTitle.classList.add('hidden');
            if (btnEditPlateName) btnEditPlateName.classList.add('hidden');
            plateNameInput.classList.remove('hidden');
            plateNameInput.focus();
            plateNameInput.select();
        };
        if (btnEditPlateName) btnEditPlateName.addEventListener('click', startEditPlateName);
        modernPlateTitle.addEventListener('click', startEditPlateName);

        const finishEditPlateName = () => {
            plateNameInput.classList.add('hidden');
            modernPlateTitle.classList.remove('hidden');
            if (btnEditPlateName) btnEditPlateName.classList.remove('hidden');
            const val = plateNameInput.value.trim();
            modernPlateTitle.textContent = val || ('Plate ' + (activePlateIndex + 1));
        };
        plateNameInput.addEventListener('blur', finishEditPlateName);
        plateNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') plateNameInput.blur();
        });
    }

    const modernObjectTitle = document.getElementById('modern-object-title');
    const btnEditObjectName = document.getElementById('btn-edit-object-name');
    if (modernObjectTitle && sObjectName) {
        const startEditObjectName = () => {
            modernObjectTitle.classList.add('hidden');
            if (btnEditObjectName) btnEditObjectName.classList.add('hidden');
            sObjectName.classList.remove('hidden');
            sObjectName.focus();
            sObjectName.select();
        };
        if (btnEditObjectName) btnEditObjectName.addEventListener('click', startEditObjectName);
        modernObjectTitle.addEventListener('click', startEditObjectName);

        const finishEditObjectName = () => {
            sObjectName.classList.add('hidden');
            modernObjectTitle.classList.remove('hidden');
            if (btnEditObjectName) btnEditObjectName.classList.remove('hidden');
            const val = sObjectName.value.trim();
            modernObjectTitle.textContent = val || 'Object';
        };
        sObjectName.addEventListener('blur', finishEditObjectName);
        sObjectName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sObjectName.blur();
        });
    }

    // ── Modern Advanced Settings Accordions ──
    const plateAdvToggle = document.getElementById('plate-advanced-toggle');
    const plateAdvBody = document.getElementById('plate-advanced-body');
    const plateAdvAcc = document.getElementById('plate-advanced-accordion');
    if (plateAdvToggle && plateAdvBody && plateAdvAcc) {
        plateAdvToggle.addEventListener('click', () => {
            plateAdvBody.classList.toggle('collapsed');
            plateAdvAcc.classList.toggle('open');
            const arrow = plateAdvToggle.querySelector('.config-accordion-arrow');
            if (arrow) arrow.textContent = plateAdvBody.classList.contains('collapsed') ? '▸' : '▾';
        });
    }

    const objAdvToggle = document.getElementById('obj-advanced-toggle');
    const objAdvBody = document.getElementById('obj-advanced-body');
    const objAdvAcc = document.getElementById('obj-advanced-accordion');
    if (objAdvToggle && objAdvBody && objAdvAcc) {
        objAdvToggle.addEventListener('click', () => {
            objAdvBody.classList.toggle('collapsed');
            objAdvAcc.classList.toggle('open');
            const arrow = objAdvToggle.querySelector('.config-accordion-arrow');
            if (arrow) arrow.textContent = objAdvBody.classList.contains('collapsed') ? '▸' : '▾';
        });
    }

    // Dismiss Layout Context Menu on click outside or Escape
    document.addEventListener('click', (e) => {
        if (layoutContextMenu && !layoutContextMenu.contains(e.target)) {
            hideLayoutContextMenu();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideLayoutContextMenu();
    });

    if (layoutModal) {
        layoutModal.addEventListener('click', (e) => {
            if (e.target === layoutModal) layoutModal.classList.add('hidden');
        });
    }

    if (btnOpenJobInfo) {
        btnOpenJobInfo.addEventListener('click', () => {
            if (!selectedId) {
                showToast('Select a file to edit job details', 'warn');
                return;
            }
            openJobModal(files.get(selectedId));
        });
    }

    if (btnCloseJobModal)  btnCloseJobModal.addEventListener('click', closeJobModal);
    if (btnCancelJobModal) btnCancelJobModal.addEventListener('click', closeJobModal);

    if (jobModal) {
        jobModal.addEventListener('click', (e) => {
            if (e.target === jobModal) closeJobModal();
        });
    }

    if (btnSubmit) {
        btnSubmit.addEventListener('click', () => {
            if (!selectedId) {
                showToast('Select a file to proceed', 'warn');
                return;
            }
            openLayoutModal();
        });
    }

    if (btnConfirmSubmit) {
        btnConfirmSubmit.addEventListener('click', () => {
            const team      = sTeam ? sTeam.value.trim() : '';
            const requester = sRequester ? sRequester.value.trim() : '';
            const project   = sProject ? sProject.value.trim() : '';

            if (!team || !requester || !project) {
                showToast('Please fill in Team, Requester, and Project', 'warn');
                if (!team && sTeam) sTeam.focus();
                else if (!requester && sRequester) sRequester.focus();
                else if (!project && sProject) sProject.focus();
                return;
            }

            saveGlobalPref('team', team);
            saveGlobalPref('requester', requester);
            saveGlobalPref('project', project);

            files.forEach(entry => {
                const j = entry.config.job;
                j.team      = team;
                j.requester = requester;
                j.project   = project;
                if (sPriority) j.priority = sPriority.value;
                if (sDate)     j.date     = sDate.value;
                if (sNotes)    j.notes    = sNotes.value;
            });

            closeJobModal();
            const plateCount = currentNesting ? currentNesting.plates.length : 1;
            showToast(`🚀 Print job submitted for ${files.size} parts across ${plateCount} ${plateCount === 1 ? 'plate' : 'plates'}!`, 'success', 5000);
            renderFileList();
        });
    }

    document.getElementById('config-form').querySelectorAll('input, select, textarea').forEach(el => {
        if ([sMaterial, sPreset, sSupports].includes(el)) return;
        el.addEventListener('input', onSettingChanged);
        el.addEventListener('change', onSettingChanged);
    });

    // ── Details Panel ────────────────────────────────────────────────────────
    function updateDetails(entry) {
        if (!entry) return;
        updateScopeBottomBar('part', entry);
        const g = entry.geometry, e = entry.estimates, c = entry.config;

        dTime.textContent   = PrintEstimator.formatTime(e.printTimeHours, e.printTimeMinutes);
        dWeight.textContent = `${e.weightGrams.toFixed(2)} g`;
        dVolume.textContent = `${(g.volume / 1000).toFixed(2)} cm³`;
        dBounds.textContent = `${g.bounds.width.toFixed(1)} × ${g.bounds.depth.toFixed(1)} × ${g.bounds.height.toFixed(1)}`;
        if (dPolygons) {
            const polyCount = entry.triangles ? entry.triangles.length : (g && g.triangles ? g.triangles.length : 0);
            dPolygons.textContent = polyCount > 0 ? polyCount.toLocaleString() : '--';
        }
        if (dLayers) dLayers.textContent = `${e.totalLayers} layers`;
        
        if (dTopology) {
            const prof = g.sliceProfile || { avgIslandCount: 1.0, isVaseLike: false };
            if (prof.isVaseLike) {
                dTopology.textContent = "1 Loop (Vase)";
            } else {
                dTopology.textContent = `${prof.avgIslandCount} islands/layer`;
            }
        }
        
        const ovArea = g.overhangArea ? (g.overhangArea / 100).toFixed(1) : '0';
        if (dOverhang) dOverhang.textContent = `${ovArea} cm²`;

        if (dSupportWeight) {
            if (c.supportEnabled && e.supportWeightGrams > 0.01) {
                dSupportWeight.textContent = `${e.supportWeightGrams.toFixed(1)} g (Active)`;
                dWeight.innerHTML = `${e.weightGrams.toFixed(1)} g <span style="font-size:0.75rem;color:var(--c-muted);">(${e.modelWeightGrams.toFixed(1)}g + ${e.supportWeightGrams.toFixed(1)}g sup)</span>`;
            } else if (g.supportVolume && g.supportVolume > 10) {
                const estSupGrams = (g.supportVolume / 1000) * c.materialDensity;
                dSupportWeight.textContent = `~${estSupGrams.toFixed(1)} g (Off)`;
                dWeight.textContent = `${e.weightGrams.toFixed(1)} g`;
            } else {
                dSupportWeight.textContent = `0.0 g (None)`;
                dWeight.textContent = `${e.weightGrams.toFixed(1)} g`;
            }
        } else {
            dWeight.textContent = `${e.weightGrams.toFixed(1)} g`;
        }

        const costVal = (e.weightGrams / 1000) * c.pricePerKg;
        dCost.textContent = isNaN(costVal) ? '--' : costVal.toFixed(2);
    }


    // ── Fusion 360 Add-in Local Bridge Consumer ──────────────────────────────
    const bridgeBanner = document.getElementById('fusion-bridge-banner');
    let bridgeImporting = false;

    function showBridgeBanner(html, type = 'info', autoDismissMs = 0) {
        if (!bridgeBanner) return;
        bridgeBanner.className = `fusion-bridge-banner ${type}`;
        bridgeBanner.innerHTML = html;
        bridgeBanner.classList.remove('hidden');
        if (autoDismissMs > 0) {
            setTimeout(() => {
                if (bridgeBanner.className.includes(type)) {
                    bridgeBanner.classList.add('hidden');
                }
            }, autoDismissMs);
        }
    }

    function hideBridgeBanner() {
        if (bridgeBanner) bridgeBanner.classList.add('hidden');
    }

    async function initFusionBridge(customUrl = null) {
        if (bridgeImporting) return;

        let sourceUrl = customUrl;
        if (!sourceUrl) {
            const urlParams = new URLSearchParams(window.location.search);
            const raw = urlParams.get('source') || urlParams.get('bridge');
            if (raw) {
                sourceUrl = decodeURIComponent(raw);
            }
        }

        if (!sourceUrl) return;
        if (!sourceUrl.endsWith('/')) sourceUrl += '/';

        bridgeImporting = true;
        showBridgeBanner(
            `<span class="bridge-spinner"></span> Connecting to Autodesk Fusion 360 Bridge (` +
            `<code>${sourceUrl}</code>)...<button type="button" id="btn-bridge-cancel" class="btn-subtle" style="padding:2px 8px;font-size:0.75rem;margin-left:8px;border-radius:4px;cursor:pointer;background:transparent;color:#94a3b8;">Dismiss</button>`,
            'info'
        );
        const cancelBtn = document.getElementById('btn-bridge-cancel');
        if (cancelBtn) cancelBtn.onclick = hideBridgeBanner;

        try {
            // Retry loop (up to 4 attempts with 500ms backoff)
            let manifestRes = null;
            let lastErr = null;
            for (let attempt = 1; attempt <= 4; attempt++) {
                try {
                    manifestRes = await fetch(`${sourceUrl}manifest.json`, { cache: 'no-store' });
                    if (manifestRes.ok) break;
                } catch (e) {
                    lastErr = e;
                    if (attempt < 4) await new Promise(r => setTimeout(r, 500));
                }
            }

            if (!manifestRes || !manifestRes.ok) {
                throw new Error(lastErr ? lastErr.message : `HTTP ${manifestRes ? manifestRes.status : 'timeout'}`);
            }

            const manifest = await manifestRes.json();
            if (manifest.profile) {
                const prof = manifest.profile;
                window._lastFusionProfile = prof;
                if (prof.team) saveGlobalPref('team', prof.team);
                if (prof.requester) saveGlobalPref('requester', prof.requester);
                if (prof.project) saveGlobalPref('project', prof.project);
                if (prof.date) saveGlobalPref('requiredDate', prof.date);
            }

            const parts = manifest.parts || [];
            if (parts.length === 0) {
                showBridgeBanner(`⚠️ Fusion 360 manifest has no solid bodies.`, 'error', 6000);
                bridgeImporting = false;
                return;
            }

            const total = parts.length;
            let loadedCount = 0;

            for (let i = 0; i < total; i++) {
                const p = parts[i];
                const fileName = p.fileName || p.name;
                showBridgeBanner(
                    `<span class="bridge-spinner"></span> Importing body ${i + 1} of ${total}: <b>${p.bodyName || fileName}</b>...`,
                    'info'
                );

                const fileUrl = `${sourceUrl}${encodeURIComponent(fileName)}`;
                const fileRes = await fetch(fileUrl, { cache: 'no-store' });
                if (!fileRes.ok) {
                    console.warn(`Failed to fetch part ${fileName}: HTTP ${fileRes.status}`);
                    continue;
                }

                const arrayBuf = await fileRes.arrayBuffer();
                const is3mf = fileName.toLowerCase().endsWith('.3mf');
                const fileObj = new File([arrayBuf], fileName, { type: is3mf ? 'model/3mf' : 'model/stl' });

                const prof = manifest.profile || {};
                await addFile(fileObj, {
                    name: p.bodyName || fileName.replace(/\.(stl|3mf)$/i, ''),
                    quantity: p.quantity || 1,
                    material: p.material || 'PLA',
                    color: p.color || '#0d6efd',
                    job: {
                        team: prof.team || loadGlobalPref('team', ''),
                        requester: prof.requester || loadGlobalPref('requester', ''),
                        project: prof.project || loadGlobalPref('project', ''),
                        priority: 'Normal',
                        date: prof.date || loadGlobalPref('requiredDate', ''),
                        notes: prof.notes || ''
                    }
                });
                loadedCount++;
            }

            // Signal bridge server completion
            try {
                fetch(`${sourceUrl}done`, { method: 'GET', cache: 'no-store' }).catch(() => {});
            } catch {}

            // Clean address bar query parameter without page reload
            if (window.location.search) {
                const cleanUrl = window.location.origin + window.location.pathname;
                window.history.replaceState({}, document.title, cleanUrl);
            }

            showBridgeBanner(
                `✨ Successfully imported <b>${loadedCount}</b> ${loadedCount === 1 ? 'body' : 'bodies'} from Fusion 360 (<i>${manifest.designName || 'Design'}</i>)!`,
                'success',
                6000
            );
            showToast(`🚀 Loaded ${loadedCount} bodies from Fusion 360`, 'success', 4000);

        } catch (err) {
            console.error('Fusion Bridge Error:', err);
            showBridgeBanner(
                `⚠️ Could not connect to Fusion Bridge: ${err.message}. ` +
                `<button type="button" id="btn-bridge-retry" class="btn-subtle" style="padding:2px 10px;font-size:0.75rem;margin-left:8px;border-radius:4px;cursor:pointer;background:rgba(255,255,255,0.15);color:#fff;">Retry</button> ` +
                `<button type="button" id="btn-bridge-dismiss" class="btn-subtle" style="padding:2px 8px;font-size:0.75rem;margin-left:4px;border-radius:4px;cursor:pointer;background:transparent;color:#fca5a5;">Dismiss</button>`,
                'error'
            );

            const btnRetry = document.getElementById('btn-bridge-retry');
            if (btnRetry) {
                btnRetry.onclick = () => {
                    bridgeImporting = false;
                    initFusionBridge(sourceUrl);
                };
            }
            const btnDismiss = document.getElementById('btn-bridge-dismiss');
            if (btnDismiss) {
                btnDismiss.onclick = hideBridgeBanner;
            }
        } finally {
            bridgeImporting = false;
        }
    }

    // ── Fusion 360 Add-in Modal & Download ───────────────────────────────
    const fusionModal = document.getElementById('fusion-modal');
    const btnDownloadPlugin = document.getElementById('btn-download-plugin');
    const btnImportFusion = document.getElementById('btn-import-fusion');
    const linkEmptyFusion = document.getElementById('link-empty-fusion');
    const btnCloseFusion = document.getElementById('btn-close-fusion-modal');
    const btnCloseFusionFooter = document.getElementById('btn-close-fusion-modal-footer');
    const btnFusionBridgeConnect = document.getElementById('btn-fusion-bridge-connect');
    const fusionBridgeInputUrl = document.getElementById('fusion-bridge-input-url');
    const btnDownloadZip = document.getElementById('btn-download-zip');

    function openFusionModal() {
        if (fusionModal) fusionModal.classList.remove('hidden');
    }
    function closeFusionModal() {
        if (fusionModal) fusionModal.classList.add('hidden');
    }

    if (btnDownloadPlugin) btnDownloadPlugin.addEventListener('click', openFusionModal);
    if (btnImportFusion) btnImportFusion.addEventListener('click', openFusionModal);
    if (linkEmptyFusion) linkEmptyFusion.addEventListener('click', openFusionModal);
    if (btnCloseFusion) btnCloseFusion.addEventListener('click', closeFusionModal);
    if (btnCloseFusionFooter) btnCloseFusionFooter.addEventListener('click', closeFusionModal);

    if (fusionModal) {
        fusionModal.addEventListener('click', (e) => {
            if (e.target === fusionModal) closeFusionModal();
        });
    }

    if (btnDownloadZip) {
        btnDownloadZip.addEventListener('click', () => {
            showToast('Downloading Fusion 360 Add-in ZIP…', 'info', 4000);
        });
    }

    if (btnFusionBridgeConnect) {
        btnFusionBridgeConnect.addEventListener('click', () => {
            const url = fusionBridgeInputUrl ? fusionBridgeInputUrl.value.trim() : '';
            if (url) {
                closeFusionModal();
                initFusionBridge(url);
            }
        });
    }

    // Re-check on window focus (if browser tab was already open when add-in launched)
    window.addEventListener('focus', () => {
        const freshParams = new URLSearchParams(window.location.search);
        if (freshParams.has('source') || freshParams.has('bridge')) {
            initFusionBridge();
        }
    });

    // ── Init ─────────────────────────────────────────────────────────────────
    initViewer();
    selectFile(null);
    initFusionBridge();
});

