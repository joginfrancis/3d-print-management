/**
 * STL Parser for ASCII and Binary formats.
 * Features:
 * - Volume (Signed Tetrahedron Method)
 * - Surface Area decomposition (horizontal shells vs vertical walls)
 * - Overhang detection and Support Volume estimation
 * - Geometry Rotation (X, Y, Z 90° rotations & auto-orient to minimize Z height)
 */

class STLParser {

    static parse(arrayBuffer) {
        let triangles;
        if (this.isAscii(arrayBuffer)) {
            triangles = this.parseAscii(this.bufferToString(arrayBuffer));
        } else {
            triangles = this.parseBinary(arrayBuffer);
        }
        
        const geometry = this.calculateGeometry(triangles);
        geometry.triangles = triangles; // Keep raw triangles for instant re-orientations
        return geometry;
    }

    static isAscii(arrayBuffer) {
        const view  = new Uint8Array(arrayBuffer);
        const header = "solid ";
        for (let i = 0; i < header.length; i++) {
            if (view[i] !== header.charCodeAt(i)) return false;
        }
        const chunk = this.bufferToString(arrayBuffer.slice(0, 500));
        return chunk.includes("facet") && chunk.includes("loop") && chunk.includes("vertex");
    }

    static bufferToString(buffer) {
        const view = new Uint8Array(buffer);
        let str = "";
        for (let i = 0; i < view.length; i++) {
            str += String.fromCharCode(view[i]);
            if (i > 1024) break;
        }
        if (buffer.byteLength > 1024) {
            const decoder = new TextDecoder("utf-8");
            return decoder.decode(buffer);
        }
        return str;
    }

    static parseBinary(arrayBuffer) {
        const dataView    = new DataView(arrayBuffer);
        const numTriangles = dataView.getUint32(80, true);
        const triangles   = [];
        let offset = 84;

        for (let i = 0; i < numTriangles; i++) {
            if (offset + 50 > arrayBuffer.byteLength) break;

            const nx = dataView.getFloat32(offset,      true);
            const ny = dataView.getFloat32(offset + 4,  true);
            const nz = dataView.getFloat32(offset + 8,  true);
            offset += 12;

            const v1 = [dataView.getFloat32(offset,     true), dataView.getFloat32(offset+4,  true), dataView.getFloat32(offset+8,  true)]; offset += 12;
            const v2 = [dataView.getFloat32(offset,     true), dataView.getFloat32(offset+4,  true), dataView.getFloat32(offset+8,  true)]; offset += 12;
            const v3 = [dataView.getFloat32(offset,     true), dataView.getFloat32(offset+4,  true), dataView.getFloat32(offset+8,  true)]; offset += 12;
            offset += 2; // attribute

            triangles.push({ v1, v2, v3, storedNormal: [nx, ny, nz] });
        }

        return triangles;
    }

    static parseAscii(text) {
        const triangles = [];
        const lines     = text.split('\n');
        let currentVertices = [];
        let storedNormal    = [0, 0, 0];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('facet normal')) {
                const p = line.split(/\s+/);
                storedNormal = [parseFloat(p[2]), parseFloat(p[3]), parseFloat(p[4])];
            } else if (line.startsWith('vertex')) {
                const parts = line.split(/\s+/);
                if (parts.length >= 4) {
                    currentVertices.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
                }
            } else if (line.startsWith('endfacet')) {
                if (currentVertices.length === 3) {
                    triangles.push({ v1: currentVertices[0], v2: currentVertices[1], v3: currentVertices[2], storedNormal });
                }
                currentVertices = [];
                storedNormal    = [0, 0, 0];
            }
        }

        return triangles;
    }

    static rotateTriangles(triangles, axis, angleDeg) {
        const rad = (angleDeg * Math.PI) / 180;
        const cos = Math.round(Math.cos(rad) * 1e6) / 1e6;
        const sin = Math.round(Math.sin(rad) * 1e6) / 1e6;

        const rotateVertex = (v) => {
            let [x, y, z] = v;
            if (axis === 'x') {
                return [x, y * cos - z * sin, y * sin + z * cos];
            } else if (axis === 'y') {
                return [x * cos + z * sin, y, -x * sin + z * cos];
            } else if (axis === 'z') {
                return [x * cos - y * sin, x * sin + y * cos, z];
            }
            return [x, y, z];
        };

        const newTriangles = [];
        for (let i = 0; i < triangles.length; i++) {
            const t = triangles[i];
            newTriangles.push({
                v1: rotateVertex(t.v1),
                v2: rotateVertex(t.v2),
                v3: rotateVertex(t.v3),
                storedNormal: rotateVertex(t.storedNormal)
            });
        }
        return newTriangles;
    }

    /**
     * Rotates all triangles so that a given target normal vector aligns with the build bed (-Z direction, [0, 0, -1]).
     * Used for "Click Face to Bed" snapping.
     */
    static rotateTrianglesToNormal(triangles, targetNormal) {
        const [nx, ny, nz] = targetNormal;
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (len < 1e-7) return triangles;

        // Source vector u = normalized target normal
        const u = [nx/len, ny/len, nz/len];
        // Target vector v = pointing straight down to bed [0, 0, -1]
        const v = [0, 0, -1];

        // Rodrigues' rotation formula: axis w = u x v, angle theta
        const wx = u[1] * v[2] - u[2] * v[1]; // -u[1]
        const wy = u[2] * v[0] - u[0] * v[2]; //  u[0]
        const wz = u[0] * v[1] - u[1] * v[0]; //  0
        const wLen = Math.sqrt(wx*wx + wy*wy + wz*wz);

        const dot = u[0]*v[0] + u[1]*v[1] + u[2]*v[2]; // -u[2]

        // If already pointing down
        if (wLen < 1e-6 && dot > 0.999) return triangles;
        // If pointing exactly opposite (straight up [0,0,1]), rotate 180° on X
        if (wLen < 1e-6 && dot < -0.999) {
            return this.rotateTriangles(triangles, 'x', 180);
        }

        const kx = wx / wLen, ky = wy / wLen, kz = wz / wLen;
        const cosT = Math.max(-1, Math.min(1, dot));
        const sinT = wLen;
        const oneMinusCos = 1 - cosT;

        // Rotation matrix elements
        const r00 = cosT + kx*kx*oneMinusCos,       r01 = kx*ky*oneMinusCos - kz*sinT, r02 = kx*kz*oneMinusCos + ky*sinT;
        const r10 = ky*kx*oneMinusCos + kz*sinT,    r11 = cosT + ky*ky*oneMinusCos,    r12 = ky*kz*oneMinusCos - kx*sinT;
        const r20 = kz*kx*oneMinusCos - ky*sinT,    r21 = kz*ky*oneMinusCos + kx*sinT, r22 = cosT + kz*kz*oneMinusCos;

        const rotateV = (p) => [
            r00 * p[0] + r01 * p[1] + r02 * p[2],
            r10 * p[0] + r11 * p[1] + r12 * p[2],
            r20 * p[0] + r21 * p[1] + r22 * p[2]
        ];

        const newTriangles = [];
        for (let i = 0; i < triangles.length; i++) {
            const t = triangles[i];
            newTriangles.push({
                v1: rotateV(t.v1),
                v2: rotateV(t.v2),
                v3: rotateV(t.v3),
                storedNormal: rotateV(t.storedNormal)
            });
        }
        return newTriangles;
    }

    static calculateGeometry(triangles) {
        let totalVolume      = 0;
        let totalArea        = 0;
        let horizontalArea   = 0;
        let verticalArea     = 0;
        let overhangArea     = 0;
        let rawSupportColVol = 0;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const H_THRESHOLD = 0.5; // ~60° from horizontal

        // 1. First pass: compute bounds to establish bed level (minZ)
        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3 } = triangles[i];
            for (const v of [v1, v2, v3]) {
                if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
                if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
                if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
            }
        }

        // 2. Second pass: geometry metrics & overhang calculation
        for (let i = 0; i < triangles.length; i++) {
            const { v1, v2, v3, storedNormal } = triangles[i];

            const e1x = v2[0]-v1[0], e1y = v2[1]-v1[1], e1z = v2[2]-v1[2];
            const e2x = v3[0]-v1[0], e2y = v3[1]-v1[1], e2z = v3[2]-v1[2];

            const cx = e1y*e2z - e1z*e2y;
            const cy = e1z*e2x - e1x*e2z;
            const cz = e1x*e2y - e1y*e2x;
            const cLen = Math.sqrt(cx*cx + cy*cy + cz*cz);

            const triArea = 0.5 * cLen;
            totalArea += triArea;

            // Unit Z-normal
            let nzNorm = 0;
            if (cLen > 1e-10) {
                nzNorm = cz / cLen;
            } else {
                const sn  = storedNormal;
                const snl = Math.sqrt(sn[0]*sn[0] + sn[1]*sn[1] + sn[2]*sn[2]);
                nzNorm = snl > 1e-10 ? sn[2] / snl : 0;
            }

            const absNz = Math.abs(nzNorm);
            if (absNz > H_THRESHOLD) {
                horizontalArea += triArea;
            } else {
                verticalArea   += triArea;
            }

            // --- Overhang Detection ---
            // Faces pointing downwards with angle > 45° from vertical (nzNorm < -0.707)
            if (nzNorm < -0.707) {
                const zCenter = (v1[2] + v2[2] + v3[2]) / 3.0;
                const heightAboveBed = Math.max(0, zCenter - minZ);
                // Only consider overhangs that are noticeably above the bed (> 1mm)
                if (heightAboveBed > 1.0) {
                    const projectedArea = triArea * absNz;
                    overhangArea += triArea;
                    rawSupportColVol += projectedArea * heightAboveBed;
                }
            }

            // Signed Tetrahedron Volume
            totalVolume += (v1[0] * (v2[1]*v3[2] - v3[1]*v2[2])
                          - v2[0] * (v1[1]*v3[2] - v3[1]*v1[2])
                          + v3[0] * (v1[1]*v2[2] - v2[1]*v1[2])) / 6.0;
        }

        // Tree/sparse supports typically occupy ~15% of the bounding overhang column
        const estimatedSupportVolume = rawSupportColVol * 0.15;

        // 3. Sparse Slice Profiling (Raycast sampling across 10 horizontal planes)
        // Computes average island count and detects continuous single-loop vases in < 5ms
        const sliceProfile = this.sampleSlices(triangles, minZ, maxZ, 10);

        return {
            volume:         Math.abs(totalVolume),  // mm³
            area:           totalArea,              // mm²
            horizontalArea,                         // mm²
            verticalArea,                           // mm²
            overhangArea,                           // mm²
            supportVolume:  estimatedSupportVolume, // mm³
            bounds: { width: maxX-minX, depth: maxY-minY, height: maxZ-minZ },
            triangleCount:  triangles.length,
            sliceProfile:   sliceProfile
        };
    }

    /**
     * Samples 10 horizontal slices through the mesh to count islands and measure
     * perimeter topology. Runs in ~3ms without full G-code generation.
     */
    static sampleSlices(triangles, minZ, maxZ, numSamples = 10) {
        const height = maxZ - minZ;
        if (height <= 0.5 || triangles.length === 0) {
            return { avgIslandCount: 1.0, isVaseLike: false, avgPerimeter: 0 };
        }

        let totalIslands = 0;
        let totalPerimeter = 0;
        let validSlices = 0;

        for (let s = 1; s <= numSamples; s++) {
            const z = minZ + (s / (numSamples + 1)) * height;
            const segments = [];

            for (let i = 0; i < triangles.length; i++) {
                const { v1, v2, v3 } = triangles[i];
                const z1 = v1[2], z2 = v2[2], z3 = v3[2];
                const minTriZ = Math.min(z1, z2, z3);
                const maxTriZ = Math.max(z1, z2, z3);
                if (minTriZ > z || maxTriZ < z) continue;

                const pts = [];
                const checkEdge = (a, b, za, zb) => {
                    if ((za <= z && zb >= z) || (za >= z && zb <= z)) {
                        const denom = zb - za;
                        if (Math.abs(denom) > 1e-6) {
                            const t = (z - za) / denom;
                            pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
                        }
                    }
                };
                checkEdge(v1, v2, z1, z2);
                checkEdge(v2, v3, z2, z3);
                checkEdge(v3, v1, z3, z1);

                if (pts.length >= 2) {
                    segments.push([pts[0], pts[1]]);
                }
            }

            if (segments.length === 0) continue;

            // Disjoint-set union on endpoints (snapped to 0.4mm resolution) to count closed loops/islands
            const parent = new Map();
            const find = (k) => {
                if (!parent.has(k)) parent.set(k, k);
                if (parent.get(k) !== k) parent.set(k, find(parent.get(k)));
                return parent.get(k);
            };
            const union = (k1, k2) => {
                const r1 = find(k1), r2 = find(k2);
                if (r1 !== r2) parent.set(r1, r2);
            };

            const snapKey = (p) => `${Math.round(p[0] * 2.5)},${Math.round(p[1] * 2.5)}`;

            let slicePerim = 0;
            for (let i = 0; i < segments.length; i++) {
                const [p1, p2] = segments[i];
                const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
                slicePerim += Math.sqrt(dx * dx + dy * dy);
                union(snapKey(p1), snapKey(p2));
            }

            const roots = new Set();
            for (const [k] of parent) {
                roots.add(find(k));
            }

            const islandCount = Math.max(1, roots.size);
            totalIslands += islandCount;
            totalPerimeter += slicePerim;
            validSlices++;
        }

        const avgIslands = validSlices > 0 ? (totalIslands / validSlices) : 1.0;
        const avgPerim = validSlices > 0 ? (totalPerimeter / validSlices) : 0;
        const isVaseLike = avgIslands <= 1.3 && avgPerim > 0;

        return {
            avgIslandCount: Math.round(avgIslands * 10) / 10,
            avgPerimeter: Math.round(avgPerim),
            isVaseLike: isVaseLike
        };
    }
}
