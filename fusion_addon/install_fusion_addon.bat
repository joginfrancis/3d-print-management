@echo off
echo ==================================================================
echo  FabLab 3D Print Bridge - Autodesk Fusion 360 Add-in Installer
echo ==================================================================
echo.

set "TARGET_DIR=%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\FabLabPrintBridge"
set "SOURCE_DIR=%~dp0"

echo Creating Add-in directory:
echo   "%TARGET_DIR%"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

echo.
echo Copying Add-in files...
copy /Y "%SOURCE_DIR%FabLabPrintBridge.manifest" "%TARGET_DIR%\"
copy /Y "%SOURCE_DIR%FabLabPrintBridge.py" "%TARGET_DIR%\"
if not exist "%TARGET_DIR%\resources" mkdir "%TARGET_DIR%\resources"
xcopy /Y /E /I "%SOURCE_DIR%resources" "%TARGET_DIR%\resources\"

echo.
echo ==================================================================
echo  Installation Complete!
echo ==================================================================
echo  To activate in Autodesk Fusion 360:
echo    1. Open Fusion 360
echo    2. Go to: UTILITIES tab -> ADD-INS -> Scripts and Add-Ins (Shift+S)
echo    3. Select the "Add-Ins" tab
echo    4. Find "FabLab 3D Print Bridge" in the list
echo    5. Select it and click "Run" (check "Run on Startup" if desired)
echo    6. You will see "Send to Plate Builder" in the Solid/Utility toolbar!
echo ==================================================================
echo.
pause
