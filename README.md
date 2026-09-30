# 3D Print Management & Build Plate Estimator

A powerful, browser-based 3D print preparation, orientation, nesting, and estimation platform designed for rapid manufacturing and FabLab environments.

🔗 **Live Application**: [https://joginfrancis.github.io/3d-print-management/](https://joginfrancis.github.io/3d-print-management/)

---

## ✨ Features

- **Interactive 3D Build Plate**: High-performance Three.js visualization of Bambu Lab 256×256 mm build plates with dynamic orbit, pan, snap, and transform controls.
- **Orientation & Placement Tools**:
  - 90° Axis Rotation dial and precise snapping.
  - **Auto Lay Flat / Lay on Face**: Automatic alignment to largest surface area.
  - **Auto-Orient & Gravity Fall**: Fast convex hull physics-based settling.
  - Boundary clipping & plate collision detection.
- **Multi-Plate Nesting & Workflow**:
  - 3-step progressive workflow: **Objects → Build Plates → Review & Submit**.
  - Auto-arranges parts across multiple build plates grouped by material, layer height, and print properties.
  - Persistent job metrics: real-time filament weight, print time, and cost calculations.
- **Autodesk Fusion 360 Integration**:
  - Seamless 1-click bridge via the [Fusion Bulk Export Add-in](https://github.com/joginfrancis/fusion-bulk-export-for-3d-printing).
  - Preserves CAD appearance colors, part dimensions, and component hierarchies.
  - Downloadable directly from the top navigation bar or empty state.
- **Adaptive Performance Engine**:
  - Pre-parse binary STL triangle peek in 0.01ms.
  - Rolling FPS diagnostics and GPU memory estimation.
- **Job Submission & Slicing Handshake**:
  - Bambu Studio 3MF export.
  - Comprehensive bill of materials (BOM) and job details tracking.

---

## 🚀 Quick Start (Local Development)

Because this application uses standard modern web technologies without complex build steps, you can run it locally with any static HTTP server:

```bash
# Using Python
python -m http.server 8000

# Using Node.js (npx)
npx serve .
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

---

## 🔌 Autodesk Fusion 360 Add-in

Want to export CAD models directly into this Plate Builder with 1 click?
Download and install the official add-in:
👉 [**Fusion Bulk Export for 3D Printing**](https://github.com/joginfrancis/fusion-bulk-export-for-3d-printing)

---

## 📄 License
MIT License. Developed for the FabLab Ecosystem.
