"""
Standalone Test Bridge Server (Mock Fusion 360 Export)
Use this to test the local bridge integration without running Autodesk Fusion 360.
"""

import os
import sys
import json
import time
import socket
import struct
import tempfile
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer

def create_sample_box_stl(filepath, sx=50.0, sy=40.0, sz=25.0):
    """Generates a valid binary STL cube of dimensions (sx, sy, sz) mm."""
    header = b'Mock Fusion 360 Exported Box STL' + b'\x00' * (80 - len('Mock Fusion 360 Exported Box STL'))
    
    # 12 triangles for a box
    triangles = [
        # Top (+Z)
        ((0,0,1), ((-sx/2, -sy/2, sz), (sx/2, -sy/2, sz), (sx/2, sy/2, sz))),
        ((0,0,1), ((-sx/2, -sy/2, sz), (sx/2, sy/2, sz), (-sx/2, sy/2, sz))),
        # Bottom (-Z)
        ((0,0,-1), ((-sx/2, -sy/2, 0), (sx/2, sy/2, 0), (sx/2, -sy/2, 0))),
        ((0,0,-1), ((-sx/2, -sy/2, 0), (-sx/2, sy/2, 0), (sx/2, sy/2, 0))),
        # Front (-Y)
        ((0,-1,0), ((-sx/2, -sy/2, 0), (sx/2, -sy/2, 0), (sx/2, -sy/2, sz))),
        ((0,-1,0), ((-sx/2, -sy/2, 0), (sx/2, -sy/2, sz), (-sx/2, -sy/2, sz))),
        # Back (+Y)
        ((0,1,0), ((-sx/2, sy/2, 0), (sx/2, sy/2, sz), (sx/2, sy/2, 0))),
        ((0,1,0), ((-sx/2, sy/2, 0), (-sx/2, sy/2, sz), (sx/2, sy/2, sz))),
        # Left (-X)
        ((-1,0,0), ((-sx/2, -sy/2, 0), (-sx/2, -sy/2, sz), (-sx/2, sy/2, sz))),
        ((-1,0,0), ((-sx/2, -sy/2, 0), (-sx/2, sy/2, sz), (-sx/2, sy/2, 0))),
        # Right (+X)
        ((1,0,0), ((sx/2, -sy/2, 0), (sx/2, sy/2, sz), (sx/2, -sy/2, sz))),
        ((1,0,0), ((sx/2, -sy/2, 0), (sx/2, sy/2, 0), (sx/2, sy/2, sz))),
    ]
    
    with open(filepath, 'wb') as f:
        f.write(header)
        f.write(struct.pack('<I', len(triangles)))
        for normal, (p1, p2, p3) in triangles:
            f.write(struct.pack('<3f', *normal))
            f.write(struct.pack('<3f', *p1))
            f.write(struct.pack('<3f', *p2))
            f.write(struct.pack('<3f', *p3))
            f.write(struct.pack('<H', 0))

class BridgeRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == '/done' or self.path == '/done/':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok","message":"Bridge session completed"}')
            print("\n[Bridge] Received /done completion ping from web app! Shutting down in 1s...")
            threading.Thread(target=lambda: (time.sleep(1.0), sys.exit(0)), daemon=True).start()
            return
        return super().do_GET()

def main():
    temp_dir = os.path.join(tempfile.gettempdir(), 'fablab_bridge', 'test_session')
    os.makedirs(temp_dir, exist_ok=True)
    
    # 1. Create mock STL models
    stl1 = os.path.join(temp_dir, 'Robot_Chassis_Mount.stl')
    stl2 = os.path.join(temp_dir, 'Sensor_Bracket.stl')
    create_sample_box_stl(stl1, sx=60.0, sy=45.0, sz=20.0)
    create_sample_box_stl(stl2, sx=35.0, sy=35.0, sz=30.0)
    
    # 2. Write manifest.json
    manifest = {
        "sessionId": "mock_test_123",
        "designName": "Robotics_Assembly_v3",
        "exportedAt": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        "count": 2,
        "parts": [
            {
                "id": "part_1",
                "name": "Robot_Chassis_Mount.stl",
                "fileName": "Robot_Chassis_Mount.stl",
                "bodyName": "Robot_Chassis_Mount",
                "material": "PETG",
                "color": "#00ae42",
                "quantity": 2,
                "dimensions": { "width": 60.0, "depth": 45.0, "height": 20.0 }
            },
            {
                "id": "part_2",
                "name": "Sensor_Bracket.stl",
                "fileName": "Sensor_Bracket.stl",
                "bodyName": "Sensor_Bracket",
                "material": "PLA",
                "color": "#ef4444",
                "quantity": 1,
                "dimensions": { "width": 35.0, "depth": 35.0, "height": 30.0 }
            }
        ]
    }
    with open(os.path.join(temp_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)

    # 3. Find free port and bind
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    
    class CustomServer(ThreadingTCPServer):
        allow_reuse_address = True
        
    def handler_factory(*args, **kwargs):
        return BridgeRequestHandler(*args, directory=temp_dir, **kwargs)

    httpd = CustomServer(('127.0.0.1', port), handler_factory)
    
    bridge_url = f"http://127.0.0.1:{port}/"
    app_url = f"http://localhost:8000/?source={bridge_url}"
    
    print("==================================================================")
    print(" FabLab 3D Print Bridge  Standalone Mock Server")
    print("==================================================================")
    print(f"Session Dir : {temp_dir}")
    print(f"Bridge Port : {port}")
    print(f"Bridge URL  : {bridge_url}")
    print(f"Plate URL   : {app_url}")
    print("------------------------------------------------------------------")
    print("Serving manifest.json and 2 mock binary STL files with CORS...")
    print("Press Ctrl+C to terminate.")
    print("==================================================================")
    
    if '--no-browser' not in sys.argv:
        webbrowser.open(app_url)
        
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped bridge server.")
    finally:
        httpd.server_close()

if __name__ == '__main__':
    main()
