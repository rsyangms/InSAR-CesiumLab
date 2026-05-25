
// ---- 编码器缓存 ----
let _encoder = null;
function getEncoder() {
    if (!_encoder) _encoder = new TextEncoder();
    return _encoder;
}

// ---- 8 字节对齐 ----
function pad8(uint8) {
    const rem = uint8.length % 8;
    if (rem === 0) return uint8;
    const out = new Uint8Array(uint8.length + (8 - rem));
    out.set(uint8);
    out.fill(0x20, uint8.length);
    return out;
}

export function pad8Bytes(uint8) {
    const rem = uint8.length % 8;
    if (rem === 0) return uint8;
    const out = new Uint8Array(uint8.length + (8 - rem));
    out.set(uint8);
    return out;
}

// ---- 单层 pnts 二进制构建 ----
export function buildPntsBlob(data) {
    if (!data || !data.length) throw new Error('buildPntsBlob: 数据为空');
    const N = data.length;

    const ecefX = new Float64Array(N);
    const ecefY = new Float64Array(N);
    const ecefZ = new Float64Array(N);
    let cx = 0, cy = 0, cz = 0;

    for (let i = 0; i < N; i++) {
        const d = data[i];
        const cart = Cesium.Cartesian3.fromDegrees(d.longitude, d.latitude, d.height || 0);
        ecefX[i] = cart.x;
        ecefY[i] = cart.y;
        ecefZ[i] = cart.z;
        cx += cart.x; cy += cart.y; cz += cart.z;
    }
    cx /= N; cy /= N; cz /= N;

    const posBinary = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const j = i * 3;
        posBinary[j] = ecefX[i] - cx;
        posBinary[j + 1] = ecefY[i] - cy;
        posBinary[j + 2] = ecefZ[i] - cz;
    }

    const defBinary = new Float32Array(N);
    const groundHeightBinary = new Float32Array(N);
    const terrainExaggerationBinary = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        defBinary[i] = data[i].deformation;
        groundHeightBinary[i] = Number(data[i].groundHeight) || 0;
        terrainExaggerationBinary[i] = Number(data[i].terrainExaggeration) || 1;
    }

    const ftJSON = JSON.stringify({
        POINTS_LENGTH: N,
        RTC_CENTER: [cx, cy, cz],
        POSITION: { byteOffset: 0 }
    });

    const btJSON = JSON.stringify({
        deformation: {
            byteOffset: 0,
            componentType: 'FLOAT',
            type: 'SCALAR'
        },
        groundHeight: {
            byteOffset: defBinary.byteLength,
            componentType: 'FLOAT',
            type: 'SCALAR'
        },
        terrainExaggeration: {
            byteOffset: defBinary.byteLength + groundHeightBinary.byteLength,
            componentType: 'FLOAT',
            type: 'SCALAR'
        }
    });

    const ftJSONBytes = pad8(getEncoder().encode(ftJSON));
    const btJSONBytes = pad8(getEncoder().encode(btJSON));

    const ftBinarySize = posBinary.byteLength;
    const btBinarySize = defBinary.byteLength + groundHeightBinary.byteLength + terrainExaggerationBinary.byteLength;

    const HEADER_SIZE = 28;
    let totalSize = HEADER_SIZE
        + ftJSONBytes.length + ftBinarySize
        + btJSONBytes.length + btBinarySize;
    if (totalSize % 8 !== 0) {
        totalSize += 8 - (totalSize % 8);
    }

    if (totalSize > 2.1e9) {
        throw new Error(`pnts 过大 (${(totalSize / 1e9).toFixed(2)}GB)，请减少点数`);
    }

    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let off = 0;

    dv.setUint8(off, 0x70); off++;
    dv.setUint8(off, 0x6E); off++;
    dv.setUint8(off, 0x74); off++;
    dv.setUint8(off, 0x73); off++;

    dv.setUint32(off, 1, true); off += 4;
    dv.setUint32(off, totalSize, true); off += 4;
    dv.setUint32(off, ftJSONBytes.length, true); off += 4;
    dv.setUint32(off, ftBinarySize, true); off += 4;
    dv.setUint32(off, btJSONBytes.length, true); off += 4;
    dv.setUint32(off, btBinarySize, true); off += 4;

    u8.set(ftJSONBytes, off); off += ftJSONBytes.length;
    u8.set(new Uint8Array(posBinary.buffer, posBinary.byteOffset, posBinary.byteLength), off); off += ftBinarySize;
    u8.set(btJSONBytes, off); off += btJSONBytes.length;
    u8.set(new Uint8Array(defBinary.buffer, defBinary.byteOffset, defBinary.byteLength), off); off += defBinary.byteLength;
    u8.set(new Uint8Array(groundHeightBinary.buffer, groundHeightBinary.byteOffset, groundHeightBinary.byteLength), off); off += groundHeightBinary.byteLength;
    u8.set(new Uint8Array(terrainExaggerationBinary.buffer, terrainExaggerationBinary.byteOffset, terrainExaggerationBinary.byteLength), off);

    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    let minH = Infinity, maxH = -Infinity;
    let maxDist = 0;
    for (let i = 0; i < N; i++) {
        const d = data[i];
        const lon = d.longitude, lat = d.latitude, h = d.height || 0;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        const dx = ecefX[i] - cx, dy = ecefY[i] - cy, dz = ecefZ[i] - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > maxDist) maxDist = dist;
    }
    const deg2rad = Math.PI / 180;
    const region = [
        (minLon - 5) * deg2rad, (minLat - 5) * deg2rad,
        (maxLon + 5) * deg2rad, (maxLat + 5) * deg2rad,
        -50000, 5000000
    ];
    const sphere = [cx, cy, cz, Math.max(maxDist * 2, 500000)];

    const blob = new Blob([buf], { type: 'application/octet-stream' });

    return {
        blob,
        pointCount: N,
        byteSize: totalSize,
        rtcCenter: [cx, cy, cz],
        region,
        sphere
    };
}

// ---- 构建单层 tileset.json (Blob) ----
// 优先使用 sphere 包围体（比 region 更鲁棒的视锥裁剪判断）
export function buildTilesetJsonBlob({ pntsUrl, region, sphere, geometricError = 10 }) {
    const boundingVolume = sphere
        ? { sphere: sphere }
        : { region: region || [0, 0, 0, 0, -1000, 1000000] };

    const tileset = {
        asset: { version: '1.0' },
        geometricError: geometricError * 10,
        root: {
            boundingVolume: boundingVolume,
            geometricError: geometricError,
            refine: 'ADD',
            content: {
                uri: pntsUrl
            }
        }
    };
    const json = JSON.stringify(tileset);
    return new Blob([json], { type: 'application/json' });
}

// ---- 从数据数组构建完整 tileset (pnts + tileset.json) ----
export function createTilesetUrls(data, geometricError) {
    const pntsResult = buildPntsBlob(data);
    const pntsUrl = URL.createObjectURL(pntsResult.blob);
    const tilesetBlob = buildTilesetJsonBlob({
        pntsUrl: pntsUrl,
        region: pntsResult.region,
        geometricError: geometricError || 1
    });
    const tilesetUrl = URL.createObjectURL(tilesetBlob);

    return {
        tilesetUrl,
        pntsUrl,
        pointCount: pntsResult.pointCount,
        byteSize: pntsResult.byteSize,
        rtcCenter: pntsResult.rtcCenter
    };
}

// ---- 性能分数换算 ----
export function formatByteSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
    return bytes + ' B';
}
