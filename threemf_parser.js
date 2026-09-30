/**
 * ThreeMFParser — Lightweight, native client-side 3MF model parser.
 * Reads .3mf OPC ZIP archives, decompresses 3D/3dmodel.model,
 * and extracts vertices, triangles, and bounding geometry.
 * Compatible with STLParser geometry representation.
 */

class ThreeMFParser {

    static is3MF(arrayBuffer) {
        if (!arrayBuffer || arrayBuffer.byteLength < 4) return false;
        const view = new DataView(arrayBuffer);
        // Standard ZIP local file header signature 0x04034b50
        return view.getUint32(0, true) === 0x04034b50;
    }

    /**
     * Extracts XML text from 3D/3dmodel.model inside a 3MF (ZIP) archive.
     */
    static async extractModelXml(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        const len = arrayBuffer.byteLength;

        // 1. Locate End of Central Directory Record (0x06054b50)
        let eocdOffset = -1;
        for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
            if (view.getUint32(i, true) === 0x06054b50) {
                eocdOffset = i;
                break;
            }
        }

        if (eocdOffset === -1) {
            throw new Error('Not a valid 3MF ZIP archive (EOCD not found).');
        }

        const cdOffset = view.getUint32(eocdOffset + 16, true);
        const cdEntries = view.getUint16(eocdOffset + 10, true);

        // 2. Iterate Central Directory entries to find the 3D model XML
        let cur = cdOffset;
        for (let i = 0; i < cdEntries; i++) {
            if (cur + 46 > len || view.getUint32(cur, true) !== 0x02014b50) break;

            const compMethod = view.getUint16(cur + 10, true);
            const compSize = view.getUint32(cur + 20, true);
            const fnLen = view.getUint16(cur + 28, true);
            const extraLen = view.getUint16(cur + 30, true);
            const commentLen = view.getUint16(cur + 32, true);
            const localOffset = view.getUint32(cur + 42, true);

            const fnBytes = new Uint8Array(arrayBuffer, cur + 46, fnLen);
            const fileName = new TextDecoder('utf-8').decode(fnBytes);

            if (fileName.toLowerCase().endsWith('.model') || fileName.includes('3D/')) {
                // Read local file header to get its extra field length
                const localExtraLen = view.getUint16(localOffset + 28, true);
                const dataStart = localOffset + 30 + fnLen + localExtraLen;
                const compressedBytes = new Uint8Array(arrayBuffer, dataStart, compSize);

                if (compMethod === 0) {
                    // Stored / uncompressed
                    return new TextDecoder('utf-8').decode(compressedBytes);
                } else if (compMethod === 8) {
                    // Deflate compression
                    if (typeof DecompressionStream !== 'undefined') {
                        const ds = new DecompressionStream('deflate-raw');
                        const writer = ds.writable.getWriter();
                        writer.write(compressedBytes);
                        writer.close();
                        const resp = await new Response(ds.readable).arrayBuffer();
                        return new TextDecoder('utf-8').decode(resp);
                    } else {
                        throw new Error('DecompressionStream not supported in this browser environment.');
                    }
                } else {
                    throw new Error(`Unsupported 3MF compression method: ${compMethod}`);
                }
            }

            cur += 46 + fnLen + extraLen + commentLen;
        }

        throw new Error('No .model file found in 3MF archive.');
    }

    /**
     * Parses an arrayBuffer of a .3mf file and returns geometry object.
     */
    static async parse(arrayBuffer) {
        const xmlText = await this.extractModelXml(arrayBuffer);
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'application/xml');

        // Check unit
        const modelEl = doc.querySelector('model');
        const unit = (modelEl && modelEl.getAttribute('unit') || 'millimeter').toLowerCase();
        let scale = 1.0;
        if (unit === 'micron') scale = 0.001;
        else if (unit === 'centimeter') scale = 10.0;
        else if (unit === 'inch') scale = 25.4;
        else if (unit === 'foot') scale = 304.8;
        else if (unit === 'meter') scale = 1000.0;

        // Parse all vertices
        const vertexEls = doc.querySelectorAll('vertex');
        const vertices = new Array(vertexEls.length);
        for (let i = 0; i < vertexEls.length; i++) {
            const v = vertexEls[i];
            vertices[i] = [
                parseFloat(v.getAttribute('x') || '0') * scale,
                parseFloat(v.getAttribute('y') || '0') * scale,
                parseFloat(v.getAttribute('z') || '0') * scale
            ];
        }

        // Parse all triangles
        const triangleEls = doc.querySelectorAll('triangle');
        const triangles = [];
        for (let i = 0; i < triangleEls.length; i++) {
            const t = triangleEls[i];
            const i1 = parseInt(t.getAttribute('v1'), 10);
            const i2 = parseInt(t.getAttribute('v2'), 10);
            const i3 = parseInt(t.getAttribute('v3'), 10);

            const v1 = vertices[i1];
            const v2 = vertices[i2];
            const v3 = vertices[i3];

            if (!v1 || !v2 || !v3) continue;

            // Compute face normal: (v2 - v1) x (v3 - v1)
            const ax = v2[0] - v1[0], ay = v2[1] - v1[1], az = v2[2] - v1[2];
            const bx = v3[0] - v1[0], by = v3[1] - v1[1], bz = v3[2] - v1[2];
            const nx = ay * bz - az * by;
            const ny = az * bx - ax * bz;
            const nz = ax * by - ay * bx;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            const normal = [nx / len, ny / len, nz / len];

            triangles.push({
                v1: [v1[0], v1[1], v1[2]],
                v2: [v2[0], v2[1], v2[2]],
                v3: [v3[0], v3[1], v3[2]],
                storedNormal: normal
            });
        }

        // Calculate bounding box, volume, and surface area via STLParser calculator
        const geometry = STLParser.calculateGeometry(triangles);
        geometry.triangles = triangles;
        return geometry;
    }
}

if (typeof window !== 'undefined') {
    window.ThreeMFParser = ThreeMFParser;
}
