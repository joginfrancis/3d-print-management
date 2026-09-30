# FabLab 3D Print Bridge for Autodesk Fusion 360

Seamless 1-click bridge from Autodesk Fusion 360 to the **FabLab 3D Print Plate Builder** web application.

---

## What It Does

1. **Direct CAD to Plate Export**:
   - In Autodesk Fusion 360, click **"Send to Plate Builder"** on the toolbar.
   - Choose specific solid bodies/components, or let it automatically capture all visible bodies in your active design.
   - Select default material profile (PLA, PETG, ABS, TPU) and copies per part.
2. **High-Precision Mesh Export**:
   - Exports high-refinement binary STLs using Fusion's native `ExportManager`.
   - Extracts CAD appearance colors (RGB hex), part dimensions, and body names.
3. **Local Ephemeral Bridge**:
   - Automatically spins up an ephemeral, CORS-compliant local HTTP server.
   - Opens your browser with all parts, materials, and colors pre-loaded and placed on the 3D build plate.
   - Auto-terminates once the web app receives the models.

---

## Quick Installation

### Windows (Automated 1-Click)
Double-click `install_fusion_addon.bat` in this folder. It will copy the add-in to:
`%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\FabLabPrintBridge\`

### Manual Installation (Windows or macOS)
Copy this entire `fusion_addon` folder to:

- **Windows**:
  `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\FabLabPrintBridge`
  *(typically `C:\Users\<Username>\AppData\Roaming\Autodesk\Autodesk Fusion 360\API\AddIns\FabLabPrintBridge`)*

- **macOS**:
  `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/FabLabPrintBridge`

---

## How to Use in Fusion 360

1. In Fusion 360, navigate to the **UTILITIES** tab (or press **Shift + S**).
2. Click **Scripts and Add-Ins**, then click the **Add-Ins** tab.
3. Find **FabLab 3D Print Bridge** in the list.
4. Click **Run** (optionally check *"Run on Startup"*).
5. A button labeled **"Send to Plate Builder"** will now appear on your toolbar.
6. Click it, confirm your selection and settings, and click **OK**.
7. The FabLab Plate Builder will automatically open in your browser with your parts loaded!

---

## Testing Without Fusion 360

You can test the entire bridge integration and browser communication standalone:

```bash
python test_bridge_server.py
```

This launches a mock bridge server, creates 2 sample CAD models with custom colors and materials, and opens `http://localhost:8000/?source=...` to verify the import pipeline.
