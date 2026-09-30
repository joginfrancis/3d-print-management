# FabLab 3D Print Management System
## Interactive Development Tracker & Architecture Reference

> **Last Updated**: 2026-09-14  
> **Repository**: `3D print management`  
> **Environment**: FabLab — Bambu Lab P1S printers  
> **Stack**: Fusion 360 Plugin (Python) · Browser App (Vanilla JS + Three.js) · Google Workspace

---

## Quick Status

| Component | Status | Progress |
|---|---|---|
| Phase 0 — Stabilise single-part viewer | ✅ DONE | `████████████` 100% |
| Phase 1 — Multi-part scene & Two-Tab Workflow | ✅ DONE | `████████████` 100% |
| Phase 2 — Nesting Engine & Build Plates Layout | ✅ DONE | `████████████` 100% |
| Phase 3 — Bambu 3MF writer | 🟡 NEXT UP | `░░░░░░░░░░░░` 0% |
| Phase 4 — Fusion 360 plugin | ✅ DONE | `████████████` 100% |
| Phase 5 — Cloud backend | 🔲 NOT STARTED | `░░░░░░░░░░░░` 0% |
| Phase 6 — Operator Scheduler | 🔲 NOT STARTED | `░░░░░░░░░░░░` 0% |
| Phase 7 — Interactive plate preview | 🔲 NOT STARTED | `░░░░░░░░░░░░` 0% |
| Phase 8 — Polish & analytics | 🔲 NOT STARTED | `░░░░░░░░░░░░` 0% |

---

## System Architecture

Three-component end-to-end pipeline:

```
FUSION 360 (CAD)
  │  Python plugin — select bodies → export → send
  │  Local HTTP server bridges Fusion → browser
  ▼
PLATE BUILDER WEB APP  (GitHub Pages, browser only)
  │  Orient · Nest · Preview · Configure · Submit
  ▼
GOOGLE WORKSPACE BACKEND  (serverless)
  │  Apps Script API · Drive (files) · Sheets (database)
  ▼
OPERATOR SCHEDULER WEB APP  (GitHub Pages, browser only)
  │  Gantt chart · Drag-drop · bambustudio:// launch
  ▼
BAMBU STUDIO + P1S PRINTERS
```

---

## Phase 0 — Stabilise Single-Part Viewer ✅ DONE

**Completed**: September 2026  
**Commits**: `93a9840`, `f6602dd`, `28356ed`, `1347efa`, `cdefd70`

### Features
- [x] STL binary + ASCII parser (`stl_parser.js`)
- [x] Three.js 3D viewport with orbit controls
- [x] Build plate 256×256mm with grid
- [x] Gravity fall — physics-based orientation settling
- [x] Fix: gravity fall flip on circular/ring models (`f6602dd`)
- [x] Auto-orient — planar region detection + convex hull
- [x] Fix: side convex hull planes restored (`28356ed`)
- [x] Convex hull balloon visualiser (click-to-orient landing discs)
- [x] X/Y/Z step rotation — floating bottom-center bar (`1347efa`)
- [x] TransformControls gizmo (rotate, move, scale)
- [x] `bakeMeshTransform()` — STL-space bake of Three.js transforms
- [x] Print estimator (time, weight, filament cost)
- [x] Material profiles — PLA / PETG / ABS / TPU
- [x] Job metadata form (team, requester, project, priority)
- [x] Multi-file list (single mesh active at a time)
- [x] Plate fit detection — warns when model exceeds 256mm
- [x] Light/dark theme toggle (persisted in localStorage)
- [x] Adaptive performance manager — triangle peek, FPS tracking (`93a9840`)
- [x] Sequential multi-file loading — no parse storms on multi-drop
- [x] Recursive GPU disposal on delete — no memory leaks
- [x] Dev diagnostics panel `Ctrl+Shift+P` — FPS, triangles, draw calls
- [x] Remove blur from auto-orient modal (`7080a88`)
- [x] SVG icon system — dynamic loader (`800f7a4`)
- [x] Auto-orient: no blur, popup only (`7080a88`)
- [x] FabLab future plan document (`FUTURE_PLAN_FABLAB_SYSTEM.md`)
- [x] Full system architecture documented (`SYSTEM_ARCHITECTURE.md`)

---

## Phase 1 — Multi-Part Scene & Two-Tab Workflow ✅ DONE
**Completed**: September 2026  
**Goal**: Clean separation of single-part resting preparation ("Objects") and multi-part build plate arrangement ("Layouts")

### 1.1 Two-Tab Application Structure
- [x] Top navigation bar with `[1. Objects]` and `[2. Layouts]` tabs and real-time count badges
- [x] Objects Mode: Isolated 1-object resting phase on the bed at origin (`0, bounds.height/2, 0`)
- [x] Full single-part orientation tools active in Objects mode (`Rotate`, `Lay on Face`, `Auto Orient`, `Gravity Fall`)
- [x] Left sidebar in Objects mode: `＋ Add` button, file list with individual model cards & copies stepper (`[-] N [+]`)
- [x] Right sidebar in Objects mode: "Print Requirements" for selected part + `"Proceed to Layout ➔"`
- [x] Clean transition between Objects and Layouts preserving baked resting face

### 1.2 Material & Grouping Allocation
- [x] Auto-grouping by material (`PLA`, `PETG`, `ABS`, `ASA`, `TPU`) and layer height
- [x] Dedicated plate allocation checkbox (`Separate Plate` option)
- [x] Reason tagging: `Base Plate`, `Material Isolated`, `Layer Height Isolated`, `Dedicated Separate Plate`, `Plate Full (Bed Area Exceeded)`

---

## Phase 2 — Nesting Engine & Build Plates Layout ✅ DONE
**Completed**: September 2026  
**Goal**: Multi-copy auto-placement on 256×256mm plates, collision avoidance, 1-plate-at-a-time 3D rendering, interactive translation, planar rotation, and auto-nesting

### 2.1 Build Plate Nesting Engine (`PlateNestEngine`)
- [x] Multi-copy expansion: loops over `entry.quantity` so every requested copy is packed
- [x] Usable build envelope: 230×230mm usable area on 256×256mm PEI bed
- [x] Automatic 10mm clearance spacing (`PART_SPACING = 10mm`) between all parts
- [x] Automatic multi-plate splitting when footprints overflow bed or materials diverge
- [x] Bed occupancy calculation (`%` of usable area) and total footprint calculation
- [x] Grand total aggregation across all build plates (Total Plates, Total Parts, Combined Time, Combined Weight, Combined Cost)

### 2.2 Layout 3D Viewport & Interactive Tools
- [x] Exactly 1 plate rendered in 3D at a time (`layoutPlateGroup`) — zero multi-plate stacking or clutter
- [x] Viewport toolbar switches to Layout Tools (`#tools-layouts`):
  - [x] **Translation Tool (M)**: Constrained to bed plane only (`showX = true, showY = false, showZ = true`). Model cannot lift off bed.
  - [x] **Planar Rotation Tool (R)**: Constrained to vertical Y axis only (`showX = false, showY = true, showZ = false`). Preserves flat resting face.
  - [x] **Auto-Nest Current Plate (N)**: `PlateNestEngine.reNestPlate()` cleanly packs all parts on the active plate from bed center.
- [x] Real-time plate collision & bed boundary monitoring with warning badges

### 2.3 Layouts Sidebar Views
- [x] Left Sidebar in Layouts Mode:
  - Overall job summary card (Total plates, total parts, combined print time, weight, cost)
  - Interactive Build Plates list (`Plate 1`, `Plate 2`, ...) with part count and occupancy %
  - Clicking any plate card switches the 3D viewport to that plate and updates the right sidebar
  - Parts breakdown list for the active plate with color dots and quantities
- [x] Right Sidebar in Layouts Mode (`#plate-settings-form`):
  - Plate overview card with machine name, reason badge, and material badge
  - Machine (`bambu_x1c`, `bambu_a1`, `prusa_mk4`, `ender_3`) and material override
  - Layer height, wall loops, infill density, and support controls per plate
  - Live plate estimates grid (Bed occupancy %, parts on plate, filament weight, print time, plate cost)
  - Plate-specific comments / job instructions textarea
  - `"Proceed to Submit Job"` direct action button opening the job confirmation modal pre-filled across all plates

### 2.4 Interactive Part Reallocation ("Move to Plate" & Layout UX Refinements) ✅ DONE
- [x] **Topbar Tabs Alignment**: Positioned tabs directly to the left next to the brand title (`margin-left: 20px; margin-right: auto;`).
- [x] **Clean Tab Headers**: Removed numbered badges (1 and 2) from `Objects` and `Layouts` tabs.
- [x] **Sidebar Cleanup**: Removed redundant `"Proceed to Submit Job"` button from left sidebar, keeping a single clear call-to-action on the right configuration panel.
- [x] **3D Viewport Right-Click Context Menu**:
  - Right-clicking any part on the build plate in Layouts mode selects the model and pops up a native Bambu Studio-themed context menu.
  - Lists existing plates (`Plate 1`, `Plate 2`, ...) with part counts and current plate tag, plus `＋ Move to New Plate`.
  - Clicking any option moves the part, auto-cleans empty plates, recalculates metrics, and updates the 3D viewport.
- [x] **Left Sidebar Drag & Drop**:
  - Parts in "Parts on this Plate" list are draggable (`draggable="true"`).
  - Dragging a part onto any `.side-plate-card` drops the part onto that plate.
  - Dragging onto the `＋ Move to New Plate` card automatically allocates a new build plate.
- [x] **Left Sidebar Part Move Dropdown**:
  - Each item in "Parts on this Plate" features a dedicated `Move ▾` button and right-click context menu.
- [x] **Automatic Empty Plate Cleanup & Renumbering**:
  - If a plate has 0 parts remaining after moving, it is automatically removed and subsequent plates are renumbered.
- [x] **Live Dynamic Metric Recalculation**:
  - Both source and target plates dynamically update weight, print time, bed occupancy %, and cost upon part transfers.

### 2.5 Uniform Toolbar Icon Styling & Layouts Toolset Optimization ✅ DONE
- [x] **Visual Consistency**: Replaced mixed line-art SVGs in Layouts mode with matching 28×28px filled CAD silhouette icons (`Translate on Bed`, `Planar Yaw Rotate`, `Auto-Nest Plate`).
- [x] **CSS Isolation Fix**: Scoped `.svg-filled` CSS rules in `styles.css` specifically to filled elements, resolving the solid black circular blob issue on curved paths.
- [x] **Scoped Tool Architecture Confirmed**: Validated that 3D tumbling/face laying belongs exclusively in the Objects tab; Layouts mode strictly requires horizontal translation, planar yaw rotation, and auto-nesting to guarantee that parts maintain their prepared resting base.

---

## Phase 3 — Bambu 3MF Writer
**Target**: Weeks 10–12  
**Goal**: Export `.3mf` files that Bambu Studio opens with all settings pre-loaded

### 3.1 ZIP / fflate Integration
- [ ] Add `fflate` (browser ZIP library, 13KB gzipped)
- [ ] `fflate` runs in Web Worker for large meshes (non-blocking)
- [ ] Test: produce valid ZIP, verify in system ZIP tool

### 3.2 3MF Structure Builder (`Bambu3MFWriter.js`)
- [ ] `[Content_Types].xml` — MIME type declarations
- [ ] `_rels/.rels` — root relationships
- [ ] `3D/3dmodel.model` — mesh data (vertices, triangles, transforms per part)
- [ ] `Metadata/model_settings.config` — Bambu filament + process settings
- [ ] `Metadata/slice_info.config` — layer height, infill, walls, supports per part
- [ ] `Metadata/project_settings.json` — plate-level settings

### 3.3 Bambu-Specific Extensions
- [ ] Map our material profiles → Bambu filament presets
- [ ] Map our infill/layer settings → Bambu process settings keys
- [ ] Part colour data → Bambu object colour metadata
- [ ] Plate index assignment per part

### 3.4 Validation
- [ ] Open generated `.3mf` in Bambu Studio → correct part layout ✓
- [ ] Verify material assignments carried through ✓
- [ ] Verify infill and layer height settings loaded ✓
- [ ] Test multi-plate file (>1 plate) ✓

### 3.5 Top-Down PNG Snapshot
- [ ] Orthographic top-down camera per plate
- [ ] `renderer.render()` → `canvas.toDataURL('image/png')`
- [ ] Snapshot taken after nesting, before submission
- [ ] PNG stored alongside `.3mf` for scheduler preview

---

## Phase 4 — Fusion 360 Plugin + Local Bridge
**Target**: Weeks 13–16  
**Goal**: One click in Fusion 360 → browser opens with all parts pre-loaded

### 4.1 Fusion 360 Panel UI
- [ ] Python add-in scaffold (manifest + commands)
- [ ] Side panel opens in Fusion 360 UI
- [ ] Multi-body / component selection (checkbox list)
- [ ] Highlight selected bodies in Fusion 3D viewport
- [ ] Show: name · material appearance · bounding box · quantity field

### 4.2 Export Engine
- [ ] Export each selected body → STL via `adsk.fusion.ExportManager`
- [ ] Attempt 3MF export (richer — includes appearance data)
- [ ] `manifest.json`: `{ files, materials, colors, quantities, exportedAt }`
- [ ] Write all to temp directory: `%TEMP%\fablab_bridge\session_{UUID}\`

### 4.3 Local HTTP Bridge
- [ ] Start Python `http.server` on random available port
- [ ] Serve temp directory at `http://localhost:{PORT}/`
- [ ] Set permissive CORS headers: `Access-Control-Allow-Origin: *`
- [ ] Open browser to `https://yourapp.github.io/plate-builder?source=http://localhost:{PORT}/session_{UUID}/`
- [ ] Server auto-stops after 60 seconds (one-shot bridge)

### 4.4 Web App: Fusion Source Handler
- [ ] On load: parse `?source=` URL param
- [ ] `fetchManifest(sourceUrl)` → read `manifest.json`
- [ ] `fetchPartFiles(manifest)` → download each STL/3MF from localhost
- [ ] Show "Loading from Fusion 360..." progress indicator
- [ ] Populate file list + auto-apply material/color from manifest
- [ ] Fallback gracefully if source unreachable (use drag-drop instead)

### 4.5 3MF Material/Color Extraction
- [ ] Parse `3D/3dmodel.model` appearances from Fusion 3MF
- [ ] Map Fusion appearance name → our material + hex color
- [ ] If unmapped: prompt user to assign manually
- [ ] Cache appearance → material mapping in localStorage

---

## Phase 5 — Cloud Backend (Google Workspace)
**Target**: Weeks 17–19  
**Goal**: Submit job → files in Drive, rows in Sheets, job ID returned

### 5.1 Google Sheets Schema
- [ ] Create spreadsheet: `FabLab_3D_Print_Management`
- [ ] Tab: `Jobs` — job_id · team · requester · project · priority · status · submitted_at
- [ ] Tab: `Plates` — plate_id · job_id · material · color · status · est_time · est_weight · est_cost · file_3mf_url · preview_png_url · printer_id
- [ ] Tab: `Parts` — part_id · job_id · plate_id · name · qty · orientation · layer_height · infill
- [ ] Tab: `Printers` — printer_id · name · model · loaded_material · status · location
- [ ] Tab: `Materials` — name · color_hex · cost_per_kg · density · in_stock · supplier
- [ ] Tab: `Teams` — team_id · name · members · email · department
- [ ] Tab: `Schedule` — schedule_id · printer_id · plate_id · start · end · status · notes

### 5.2 Google Apps Script Web API
- [ ] Deploy Apps Script as Web App (`doPost`, `doGet`)
- [ ] `POST /uploadJob` — receive JSON manifest, write Sheets rows
- [ ] `POST /uploadFile` — receive base64 blob, write to Drive, return URL
- [ ] `GET /getQueue` — return plates filtered by status/material
- [ ] `POST /updateStatus` — update plate/job status field
- [ ] `POST /sendNotification` — `MailApp.sendEmail()` to team

### 5.3 Google Drive Structure
- [ ] Create root folder: `FabLab_Production/`
- [ ] Sub: `Jobs/{JOB_ID}_{team}_{project}/`
  - [ ] `originals/` — source STL/3MF files
  - [ ] `plates/` — `plate_001.3mf`, `plate_002.3mf`
  - [ ] `previews/` — `plate_001.png`, `plate_002.png`
- [ ] Sub: `Archive/` — completed jobs moved here

### 5.4 Browser Submission Flow
- [ ] `submitJob(jobData, plates)` function in app.js
- [ ] Upload each `.3mf` blob to Apps Script → get Drive URL
- [ ] Upload each PNG snapshot → get Drive URL
- [ ] POST job manifest with all Drive URLs → get job_id
- [ ] Show confirmation: job ID + tracking link
- [ ] Error handling: retry on network fail, partial upload recovery

---

## Phase 6 — Operator Scheduler Web App
**Target**: Weeks 20–25  
**Goal**: Operator views queue, schedules across printers, launches prints

### 6.1 App Scaffold
- [ ] Separate HTML/JS (new page or route: `/scheduler`)
- [ ] Google Apps Script auth (API key or OAuth)
- [ ] Responsive two-panel layout (left queue · right Gantt)

### 6.2 Left Panel — Job Queue
- [ ] Fetch pending plates from `GET /getQueue`
- [ ] Job cards: team · project · priority · plate count · materials
- [ ] Expand card → plate list with PNG preview thumbnails
- [ ] Filter bar: material · status · team · date range · priority
- [ ] Sort: newest · priority · est. print time

### 6.3 Right Panel — Gantt Chart
- [ ] Printer rows (Y-axis) — one row per P1S
- [ ] Time axis (X-axis) — hours/days, scrollable
- [ ] Plate blocks — draggable, colour-coded by material
- [ ] Estimated end time auto-calculated from est_time
- [ ] Snap-to-available-slot on drag

### 6.4 Calendar Awareness Engine
- [ ] Working hours config (start/end time, per printer or global)
- [ ] Weekend blocking (configurable: Sat only / Sat+Sun)
- [ ] Holiday list (editable in Sheets `Settings` tab)
- [ ] Maintenance window per printer (recurring or one-off)
- [ ] Visual blocked-time striping on Gantt

### 6.5 Plate Actions
- [ ] `[Open in Bambu Studio]` → `bambustudio://open?file={drive_url}`
- [ ] `[Download .3mf]` → direct Drive link
- [ ] `[Mark Printing]` → update Sheet, start countdown timer
- [ ] `[Mark Done]` → update Sheet, trigger team notification
- [ ] Operator notes field per plate

### 6.6 Notification System
- [ ] On schedule assign: email team "Your job is scheduled for {datetime}"
- [ ] On print start: email "Printing now — est. done in {time}"
- [ ] On complete: email "Your parts are ready for pickup at FabLab"
- [ ] Email template (HTML) with job details + preview image
- [ ] All via Apps Script `MailApp.sendEmail()`

---

## Phase 7 — Multi-Plate Interactive Preview
**Target**: Weeks 26–28  
**Goal**: See all plates in 3D before submitting; drag-edit parts interactively

### 7.1 Multi-Plate 3D Scene
- [ ] Side-by-side virtual plates in Three.js scene
- [ ] Each plate is a 256×256mm base with parts nested on it
- [ ] Camera orbits the full scene or focuses on one plate
- [ ] Plate tab switcher (click → camera flies to that plate)

### 7.2 Interactive Editing
- [ ] Click part in 3D → select it
- [ ] Drag part to different plate → updates nesting, re-validates
- [ ] Duplicate part → adds another copy, re-runs nesting
- [ ] Delete part → removes from scene + re-nests
- [ ] Move part manually within plate → checks for overlaps

### 7.3 Annotations
- [ ] Right-click part → add text comment
- [ ] Comments exported into `.3mf` metadata
- [ ] Operator can see comments in Scheduler

### 7.4 Re-Nesting Trigger
- [ ] "Re-run Auto Layout" button after manual changes
- [ ] Nesting worker re-runs only for affected group
- [ ] Confirm dialog before overwriting manual positions

---

## Phase 8 — Polish, Analytics & Mobile
**Target**: Weeks 29–32  
**Goal**: Production-ready for daily FabLab use

### 8.1 Analytics Dashboard
- [ ] Print history: jobs per team/week/month
- [ ] Filament usage by material type
- [ ] Cost breakdown per team (chargeback reporting)
- [ ] Printer utilisation % chart
- [ ] Average job turnaround time

### 8.2 Filament Stock Tracking
- [ ] Current stock per material/colour in Sheets
- [ ] Deduct estimated usage on print complete
- [ ] Low stock alert in Scheduler (highlight printer row)
- [ ] Reorder reminder email to operator

### 8.3 Mobile-Responsive Operator View
- [ ] Simplified mobile layout (no Gantt, just queue list)
- [ ] Mark printing / mark done from phone
- [ ] Notifications work on mobile (email → phone)

### 8.4 Reliability & Offline
- [ ] Service worker: cache app shell for offline use
- [ ] IndexedDB: save in-progress job locally if browser closes
- [ ] Batch status updates (debounce API calls)
- [ ] Upload retry with exponential backoff

---

## Technology Stack

| Layer | Technology | Status |
|---|---|---|
| 3D rendering | Three.js (local file) | ✅ Integrated |
| STL parsing | `stl_parser.js` (custom) | ✅ Done |
| Convex hull | `convex_hull.js` (custom) | ✅ Done |
| Print estimator | `estimator.js` (custom) | ✅ Done |
| Material profiles | `profiles.js` | ✅ Done |
| TransformControls | `transform_controls.js` | ✅ Done |
| Performance manager | inline `PerformanceManager` | ✅ Done |
| 3MF writer | `Bambu3MFWriter.js` | 🔲 Phase 3 |
| ZIP | `fflate` | 🔲 Phase 3 |
| Nesting engine | `nesting.worker.js` | 🔲 Phase 2 |
| Google Apps Script | Web App deployment | 🔲 Phase 5 |
| Fusion 360 plugin | Python add-in | 🔲 Phase 4 |
| Local HTTP bridge | Python `http.server` | 🔲 Phase 4 |
| Gantt chart | Custom Canvas / frappe-gantt | 🔲 Phase 6 |
| Email notifications | Apps Script MailApp | 🔲 Phase 6 |
| Hosting | GitHub Pages | 🔲 Phase 5+ |
| Offline | Service Worker + IndexedDB | 🔲 Phase 8 |

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Bambu 3MF private extensions undocumented | 🔴 High | Reverse-engineer from Bambu Studio exports |
| Fusion 360 API changes break plugin | 🟡 Medium | Pin API version; test on each Fusion update |
| Apps Script email quota (100/day free) | 🟡 Medium | Use Google Workspace account (1500/day) |
| `bambustudio://` not registered on machine | 🟡 Medium | Fallback: download `.3mf` + instructions |
| Large STL (>50MB) slow on GitHub Pages | 🟡 Medium | PerformanceManager warns; chunked upload |
| Cross-origin fetch from localhost fails | 🟡 Medium | Plugin server sets permissive CORS headers |
| Nesting quality poor for complex shapes | 🟢 Low | Plater bitmap approach fine for P1; SVGnest for V2 |
| OneDrive sync conflicts on `.md` edits | 🟢 Low | Edit via `node` scripts or git directly |

---

## Timeline

```
2026                                                    2027
Sep      Oct      Nov      Dec      Jan      Feb      Mar      Apr
│        │        │        │        │        │        │        │
█ P0 ✅
         ░░░░░░░░ P1 Multi-part scene
                  ░░░░░ P2 Nesting engine
                           ░░░░ P3 Bambu 3MF writer
                                    ░░░░░ P4 Fusion plugin
                                             ░░░ P5 Cloud backend
                                                      ░░░░░░░░░░░ P6 Scheduler
```

---

## How to Update This Tracker

When a feature is completed:
1. Change `- [ ]` to `- [x]`
2. Update the **Quick Status** table progress bar
3. Update **Last Updated** date at the top
4. Commit: `git add SYSTEM_ARCHITECTURE.md && git commit -m "tracker: complete [feature name]"`

When a phase is done:
1. Change phase heading to include `✅ DONE`
2. Add completion date and commit hash
3. Update **Quick Status** table to `✅ DONE | ████████████ 100%`
