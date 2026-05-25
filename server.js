// ===================== 用户UI和交互处理 =====================
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const TILESETS_DIR = path.join(ROOT_DIR, '.tilesets');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5177);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_MB || 512) * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pnts': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

// =========================== 入口文件 =======================
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG_TO_RAD = Math.PI / 180;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, value) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendText(res, status, text) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ===================== 用户UI和交互处理 =====================
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await requestBody(req);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch (err) {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function geodeticToEcef(longitude, latitude, height) {
  const lon = longitude * DEG_TO_RAD;
  const lat = latitude * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return {
    x: (normal + height) * cosLat * cosLon,
    y: (normal + height) * cosLat * sinLon,
    z: (normal * (1 - WGS84_E2) + height) * sinLat
  };
}

// ===================== 3D Tiles生成逻辑 =====================
function normalizePoints(input) {
  if (!Array.isArray(input)) {
    throw Object.assign(new Error('points must be an array'), { statusCode: 400 });
  }

  const points = [];
  for (const item of input) {
    const longitude = Number(item.longitude ?? item.lng ?? item.lon ?? item.x);
    const latitude = Number(item.latitude ?? item.lat ?? item.y);
    const height = Number(item.height ?? item.elevation ?? 0);
    const groundHeight = Number(item.groundHeight ?? item.sampledHeight ?? item.height ?? item.elevation ?? 0);
    const terrainExaggeration = Number(item.terrainExaggeration ?? 1);
    const deformation = Number(item.deformation ?? item.value ?? item.z ?? 0);

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(height) ||
      !Number.isFinite(groundHeight) ||
      !Number.isFinite(terrainExaggeration) ||
      !Number.isFinite(deformation)
    ) continue;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue;

    const ecef = geodeticToEcef(longitude, latitude, height);
    points.push({
      longitude,
      latitude,
      height,
      groundHeight,
      terrainExaggeration,
      deformation,
      year: item.year ?? item.time ?? null,
      x: ecef.x,
      y: ecef.y,
      z: ecef.z
    });
  }

  if (!points.length) {
    throw Object.assign(new Error('No valid points were supplied'), { statusCode: 400 });
  }

  return points;
}

// ===================== 3D Tiles生成逻辑 =====================
function padBuffer(buffer, byte, multiple = 8) {
  const remainder = buffer.length % multiple;
  if (remainder === 0) return buffer;
  const out = Buffer.alloc(buffer.length + (multiple - remainder), byte);
  buffer.copy(out, 0);
  return out;
}

function jsonBuffer(value) {
  return padBuffer(Buffer.from(JSON.stringify(value), 'utf8'), 0x20);
}

function computeSphere(points) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx /= points.length;
  cy /= points.length;
  cz /= points.length;

  let radius = 1;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > radius) radius = distance;
  }
  return [cx, cy, cz, Math.max(radius * 1.05, 1)];
}

function computeBounds(points) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minH = Infinity;
  let maxH = -Infinity;

  for (const p of points) {
    if (p.longitude < minLon) minLon = p.longitude;
    if (p.longitude > maxLon) maxLon = p.longitude;
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.height < minH) minH = p.height;
    if (p.height > maxH) maxH = p.height;
  }

  return { minLon, maxLon, minLat, maxLat, minH, maxH };
}

function splitPoints(points) {
  const bounds = computeBounds(points);
  const centerLat = (bounds.minLat + bounds.maxLat) * 0.5 * DEG_TO_RAD;
  const lonSpanMeters = Math.abs(bounds.maxLon - bounds.minLon) * 111320 * Math.max(0.1, Math.cos(centerLat));
  const latSpanMeters = Math.abs(bounds.maxLat - bounds.minLat) * 111320;

  if (lonSpanMeters < 0.01 && latSpanMeters < 0.01) return null;

  const midLon = (bounds.minLon + bounds.maxLon) * 0.5;
  const midLat = (bounds.minLat + bounds.maxLat) * 0.5;
  const buckets = [[], [], [], []];
  for (const p of points) {
    const index = (p.longitude >= midLon ? 1 : 0) + (p.latitude >= midLat ? 2 : 0);
    buckets[index].push(p);
  }

  const parts = buckets.filter(part => part.length > 0);
  if (parts.length > 1 && parts.every(part => part.length < points.length)) return parts;

  const axis = lonSpanMeters >= latSpanMeters ? 'longitude' : 'latitude';
  const sorted = [...points].sort((a, b) => a[axis] - b[axis]);
  const half = Math.floor(sorted.length / 2);
  if (half <= 0 || half >= sorted.length) return null;
  return [sorted.slice(0, half), sorted.slice(half)];
}

function buildPntsBuffer(points) {
  const count = points.length;
  const sphere = computeSphere(points);
  const [cx, cy, cz] = sphere;

  const positions = new Float32Array(count * 3);
  const deformations = new Float32Array(count);
  const groundHeights = new Float32Array(count);
  const terrainExaggerations = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = points[i];
    const offset = i * 3;
    positions[offset] = p.x - cx;
    positions[offset + 1] = p.y - cy;
    positions[offset + 2] = p.z - cz;
    deformations[i] = p.deformation;
    groundHeights[i] = p.groundHeight;
    terrainExaggerations[i] = p.terrainExaggeration;
  }

  const featureTableJson = jsonBuffer({
    POINTS_LENGTH: count,
    RTC_CENTER: [cx, cy, cz],
    POSITION: { byteOffset: 0 }
  });

  const featureTableBinary = padBuffer(Buffer.from(positions.buffer), 0x00);
  const batchTableJson = jsonBuffer({
    deformation: {
      byteOffset: 0,
      componentType: 'FLOAT',
      type: 'SCALAR'
    },
    groundHeight: {
      byteOffset: deformations.byteLength,
      componentType: 'FLOAT',
      type: 'SCALAR'
    },
    terrainExaggeration: {
      byteOffset: deformations.byteLength + groundHeights.byteLength,
      componentType: 'FLOAT',
      type: 'SCALAR'
    }
  });
  const batchTableBinary = padBuffer(
    Buffer.concat([
      Buffer.from(deformations.buffer),
      Buffer.from(groundHeights.buffer),
      Buffer.from(terrainExaggerations.buffer)
    ]),
    0x00
  );

  const headerByteLength = 28;
  const byteLength =
    headerByteLength +
    featureTableJson.length +
    featureTableBinary.length +
    batchTableJson.length +
    batchTableBinary.length;

  const header = Buffer.alloc(headerByteLength);
  header.write('pnts', 0, 4, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(byteLength, 8);
  header.writeUInt32LE(featureTableJson.length, 12);
  header.writeUInt32LE(featureTableBinary.length, 16);
  header.writeUInt32LE(batchTableJson.length, 20);
  header.writeUInt32LE(batchTableBinary.length, 24);

  return {
    buffer: Buffer.concat([header, featureTableJson, featureTableBinary, batchTableJson, batchTableBinary], byteLength),
    sphere
  };
}
// ===================== 3D Tiles生成逻辑 =====================
function buildTileTree(points, context, depth = 0) {
  const node = {
    boundingVolume: { sphere: computeSphere(points) },
    geometricError: Math.max(1, Math.round(context.geometricError / Math.pow(2, depth))),
    refine: 'ADD',
    extras: { pointCount: points.length }
  };

  const canSplit = points.length > context.maxPointsPerTile && depth < context.maxDepth;
  const parts = canSplit ? splitPoints(points) : null;

  if (!parts || !parts.length) {
    const tileName = `tile-${String(context.tileIndex++).padStart(5, '0')}.pnts`;
    const tileUri = `tiles/${tileName}`;
    const pnts = buildPntsBuffer(points);
    fs.writeFileSync(path.join(context.tilesDir, tileName), pnts.buffer);
    context.tileCount += 1;
    context.byteLength += pnts.buffer.length;
    node.boundingVolume = { sphere: pnts.sphere };
    node.geometricError = 0;
    node.content = { uri: tileUri };
    return node;
  }

  node.children = parts.map(part => buildTileTree(part, context, depth + 1));
  return node;
}

async function createTileset(payload) {
  const options = payload.options || {};
  const points = normalizePoints(payload.points);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  const outDir = path.join(TILESETS_DIR, id);
  const tilesDir = path.join(outDir, 'tiles');

  await fsp.mkdir(tilesDir, { recursive: true });

  const context = {
    tilesDir,
    maxPointsPerTile: clampInt(options.maxPointsPerTile, 5000, 250000, 80000),
    maxDepth: clampInt(options.maxDepth, 1, 12, 8),
    geometricError: clampInt(options.geometricError, 16, 4096, 1024),
    tileIndex: 0,
    tileCount: 0,
    byteLength: 0
  };

  const root = buildTileTree(points, context);
  const tileset = {
    asset: {
      version: '1.0',
      generator: 'InSAR local Cesium 3D Tiles backend'
    },
    geometricError: root.geometricError || context.geometricError,
    root,
    extras: {
      id,
      pointCount: points.length,
      tileCount: context.tileCount,
      byteLength: context.byteLength,
      maxPointsPerTile: context.maxPointsPerTile,
      maxDepth: context.maxDepth,
      createdAt: new Date().toISOString()
    }
  };

  await fsp.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));

  return {
    id,
    tilesetUrl: `/tilesets/${id}/tileset.json`,
    stats: tileset.extras
  };
}

// ===================== 安全缓冲 文件访问 =====================
function safeResolve(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.resolve(root, `.${path.sep}${normalized}`);
  if (!resolved.startsWith(path.resolve(root))) return null;
  return resolved;
}

async function serveFile(res, root, requestPath) {
  const target = safeResolve(root, requestPath);
  if (!target) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  const filePath = stat.isDirectory() ? path.join(target, 'index.html') : target;
  try {
    const fileStat = await fsp.stat(filePath);
    if (!fileStat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  setCors(res);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': filePath.includes(`${path.sep}.tilesets${path.sep}`) ? 'no-store' : 'no-cache'
  });
  fs.createReadStream(filePath).pipe(res);
}

async function deleteTileset(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) return false;
  const target = path.resolve(TILESETS_DIR, id);
  if (!target.startsWith(path.resolve(TILESETS_DIR))) return false;
  await fsp.rm(target, { recursive: true, force: true });
  return true;
}

async function route(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, tilesetsDir: TILESETS_DIR });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tilesets') {
      const payload = await readJson(req);
      const result = await createTileset(payload);
      sendJson(res, 201, result);
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/tilesets/')) {
      const id = url.pathname.split('/').pop();
      const deleted = await deleteTileset(id);
      sendJson(res, deleted ? 200 : 400, { ok: deleted });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/tilesets/')) {
      await serveFile(res, TILESETS_DIR, url.pathname.replace(/^\/tilesets/, ''));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      if (pathname.startsWith('/.git') || pathname.startsWith('/.tilesets')) {
        sendText(res, 403, 'Forbidden');
        return;
      }
      await serveFile(res, ROOT_DIR, pathname);
      return;
    }

    sendText(res, 405, 'Method not allowed');
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || 'Internal server error' });
  }
}

async function start() {
  await fsp.mkdir(TILESETS_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    route(req, res).catch(err => {
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`InSAR Cesium server running at http://${HOST}:${PORT}/`);
    console.log(`3D Tiles output: ${TILESETS_DIR}`);
  });
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});
