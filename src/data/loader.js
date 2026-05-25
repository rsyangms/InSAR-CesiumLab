// =========================== 数据解析 ===========================
import { STATE, isValidLngLat, isValidDeformation, toast, updateLoadedFilesUI, arrayMin, arrayMax } from '../core/state.js';
import { viewer, terrainProvider } from '../core/viewer.js';
import { attachGroundMetadata, getTerrainExaggerationValue } from '../render/heightModel.js';

const HEIGHT_KEYS = [
    'groundHeight',
    'sampledHeight',
    'terrainHeight',
    'height',
    'elevation',
    'altitude',
    'alt',
    'hgt',
    'dem',
];

function cleanCell(value) {
    return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function parseNumeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    let text = cleanCell(value);
    if (!text) return NaN;
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim();
    }
    text = Array.from(text, ch => {
        const code = ch.charCodeAt(0);
        if (code === 0xff0c) return ',';
        if (code === 0x2212 || code === 0xff0d) return '-';
        return ch;
    }).join('');
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
        text = text.replace(/,/g, '');
    }
    const direct = Number(text);
    if (Number.isFinite(direct)) return direct;
    const parsed = parseFloat(text);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function parseDelimitedLine(line, delimiter = ',') {
    const values = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (ch === delimiter && !quoted) {
            values.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    values.push(current);
    return values;
}

function detectDelimiter(headerLine) {
    const candidates = [',', ';', '\t'];
    let best = ',';
    let bestCount = -1;
    for (const delimiter of candidates) {
        const count = parseDelimitedLine(headerLine, delimiter).length;
        if (count > bestCount) {
            best = delimiter;
            bestCount = count;
        }
    }
    return best;
}
// ================== 第一层级 ===============
function firstFiniteHeight(...sources) {
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of HEIGHT_KEYS) {
            const value = parseNumeric(source[key]);
            if (Number.isFinite(value)) return value;
        }
    }
    return NaN;
}

function getFileGroundHeight(point) {
    const original = point?.original && typeof point.original === 'object' ? point.original : null;
    return firstFiniteHeight(point, point?.properties, original, original?.properties);
}

function withGroundHeightFromFile(point, terrainExaggeration = getTerrainExaggerationValue()) {
    const fileGroundHeight = getFileGroundHeight(point);
    if (!Number.isFinite(fileGroundHeight)) {
        return attachGroundMetadata(point, terrainExaggeration);
    }
    return attachGroundMetadata({
        ...point,
        height: fileGroundHeight,
        groundHeight: fileGroundHeight,
        groundHeightSource: point?.groundHeightSource ?? 'file',
    }, terrainExaggeration);
}

export function parseJSONData(json) {
    if (Array.isArray(json)) return json.map(item => ({
        longitude: item.lng || item.longitude || item.lon || item.x || (item.geometry?.coordinates?.[0]),
        latitude: item.lat || item.latitude || item.y || (item.geometry?.coordinates?.[1]),
        deformation: item.deformation || item.value || item.z || item.height || item.properties?.deformation || item.properties?.value || 0,
        height: firstFiniteHeight(item, item.properties),
        year: item.year || item.time || null,
        original: item
    }));
    if (json.type === 'FeatureCollection' && Array.isArray(json.features)) return json.features.map(f => ({
        longitude: f.geometry?.coordinates?.[0],
        latitude: f.geometry?.coordinates?.[1],
        deformation: f.properties?.deformation ?? f.properties?.value ?? f.properties?.height ?? 0,
        height: firstFiniteHeight(f.properties, f),
        year: f.properties?.year || f.properties?.time || null,
        original: f
    }));
    if (json.data && Array.isArray(json.data)) return json.data.map(item => ({
        longitude: item.lng || item.longitude || item.lon,
        latitude: item.lat || item.latitude,
        deformation: item.deformation || item.value || item.z || 0,
        height: firstFiniteHeight(item, item.properties),
        year: item.year || item.time || null,
        original: item
    }));
    throw new Error('无法识别的JSON格式');
}

export function parseGeoJSON(t) { return parseJSONData(JSON.parse(t)); }

export function parseJSON(t) { return parseJSONData(JSON.parse(t)); }

export function parseCSV(t) {
    const lines = t.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('CSV 至少需要标题行');

    // ---- 表头识别 (单独识别 deformation 与 height,绝不混用) ----
    const delimiter = detectDelimiter(lines[0]);
    const h = parseDelimitedLine(lines[0], delimiter).map(s => cleanCell(s).toLowerCase());
    for (let i = 0; i < h.length; i++) {
        if (/^(groundheight|ground_height|sampledheight|sampled_height|terrainheight|terrain_height|elevation|altitude|alt|hgt|dem|\u7edd\u5bf9\u9ad8\u7a0b|\u5730\u5f62\u9ad8\u7a0b|\u91c7\u6837\u9ad8\u7a0b|\u9ad8\u7a0b|\u6d77\u62d4|\u9ad8\u5ea6)$/.test(h[i])) {
            h[i] = 'height';
        }
    }

    const li = h.findIndex(x => /^\s*(longitude|lng|lon|x|经度)\s*$/.test(x));
    const ai = h.findIndex(x => /^\s*(latitude|lat|y|纬度)\s*$/.test(x));

    // 形变/速率 (deformation): 严格匹配,绝不接受 height 作为别名
    let di = h.findIndex(x => /^\s*(deformation|deform|velocity|rate|形变|沉降|速率)\s*$/.test(x));
    if (di === -1) di = h.findIndex(x => /^\s*(value|val|z)\s*$/.test(x));

    // 高程 (height): 与 deformation 完全分离
    const hi = h.findIndex(x => /^\s*(height|elevation|高程|海拔)\s*$/.test(x));

    const yi = h.findIndex(x => /^\s*(year|time|date|年份|时间|日期)\s*$/.test(x));

    // 调试日志:打印列识别结果,便于排查列错位
    console.log('[parseCSV] 表头:', h);
    console.log('[parseCSV] 列索引: lng=', li, 'lat=', ai, 'def=', di, 'hgt=', hi, 'year=', yi);

    if (li === -1 || ai === -1 || di === -1) {
        throw new Error(`CSV 缺少必要列 (lng=${li}, lat=${ai}, def=${di}). 表头: ${h.join('|')}`);
    }

    const r = [];
    for (let i = 1; i < lines.length; i++) {
        const v = parseDelimitedLine(lines[i], delimiter).map(cleanCell);
        if (v.length <= Math.max(li, ai, di)) continue;
        const height = hi >= 0 ? parseNumeric(v[hi]) : NaN;
        r.push({
            longitude:   parseNumeric(v[li]),
            latitude:    parseNumeric(v[ai]),
            deformation: parseNumeric(v[di]),
            height:      Number.isFinite(height) ? height : undefined,
            year:        yi >= 0 ? v[yi] : null,
            original:    lines[i]
        });
    }
    return r;
}

// ========================== 数据筛选 ===========================
export function validateData(data) {
    const valid = [], invalid = [];
    for (const d of data) {
        if (d.longitude == null || d.latitude == null || d.deformation == null) { invalid.push({ ...d, reason: '缺少字段' }); continue; }
        const lng = parseNumeric(d.longitude), lat = parseNumeric(d.latitude), def = parseNumeric(d.deformation);
        if (!isValidLngLat(lng, lat)) { invalid.push({ ...d, reason: '无效经纬度' }); continue; }
        if (!isValidDeformation(def)) { invalid.push({ ...d, reason: '无效形变值' }); continue; }
        const height = getFileGroundHeight(d);
        valid.push({
            longitude: lng,
            latitude: lat,
            deformation: def,
            height: Number.isFinite(height) ? height : undefined,
            groundHeight: Number.isFinite(height) ? height : undefined,
            groundHeightSource: Number.isFinite(height) ? 'file' : undefined,
            terrainExaggeration: getTerrainExaggerationValue(),
            year: d.year || null,
            original: d.original
        });
    }
    return { valid, invalid };
}

// ==================== 采样地形高度 ====================
export async function sampleTerrainHeight(data, onProgress) {
    const r = [];
    const terrainExaggeration = getTerrainExaggerationValue();
    const normalizedData = data.map(d => withGroundHeightFromFile(d, terrainExaggeration));
    for (let i = 0; i < data.length; i += 100) {
        const chunk = normalizedData.slice(i, i + 100);
        const pos = chunk.map(d => Cesium.Cartographic.fromDegrees(d.longitude, d.latitude));
        try {
            const u = await Cesium.sampleTerrainMostDetailed(terrainProvider, pos);
            u.forEach((p, j) => {
                const sampledHeight = Number(p.height);
                const groundHeight = Number.isFinite(sampledHeight)
                    ? sampledHeight
                    : Number.isFinite(Number(chunk[j]?.groundHeight))
                        ? Number(chunk[j].groundHeight)
                        : Number.isFinite(Number(chunk[j]?.height))
                            ? Number(chunk[j].height)
                            : undefined;
                if (!Number.isFinite(groundHeight)) return;
                r.push(attachGroundMetadata({
                    ...chunk[j],
                    groundHeight,
                    height: groundHeight,
                    groundHeightSource: Number.isFinite(sampledHeight) ? 'cesium' : (chunk[j]?.groundHeightSource ?? 'file'),
                }, terrainExaggeration));
            });
        } catch (err) {
            console.warn('[terrain] Cesium terrain sample failed, using file elevation fallback when available:', err?.message || err);
            chunk.forEach(d => {
                const fallbackHeight = Number.isFinite(Number(d.groundHeight))
                    ? Number(d.groundHeight)
                    : Number.isFinite(Number(d.height))
                        ? Number(d.height)
                        : undefined;
                if (!Number.isFinite(fallbackHeight)) return;
                r.push(attachGroundMetadata({
                    ...d,
                    groundHeight: fallbackHeight,
                    height: fallbackHeight,
                    groundHeightSource: d.groundHeightSource ?? 'file',
                }, terrainExaggeration));
            });
        }
        if (onProgress) onProgress(Math.min(1, (i + 100) / data.length));
    }
    return r;
}

// =========================== Voxel Grid抽稀 ===========================
const METERS_PER_DEG = 111320;

export function voxelGridDownsample(data, voxelSize, options = {}) {
    if (!data || !data.length || !voxelSize || voxelSize <= 0) return [];
    const { preserveOriginal = false } = options;

    // 以数据质心为基准计算 equirectangular 投影系数
    let sumLat = 0;
    for (let i = 0; i < data.length; i++) sumLat += data[i].latitude;
    const centerLatRad = (sumLat / data.length) * Math.PI / 180;
    const mLon = METERS_PER_DEG * Math.cos(centerLatRad);
    const mLat = METERS_PER_DEG;

    const buckets = new Map();

    for (let i = 0; i < data.length; i++) {
        const p = data[i];
        const x = p.longitude * mLon;
        const y = p.latitude * mLat;
        const z = p.height || 0;

        const ix = Math.floor(x / voxelSize);
        const iy = Math.floor(y / voxelSize);
        const iz = Math.floor(z / voxelSize);
        // 
        const key = ix + ',' + iy + ',' + iz + ',' + (p.year ?? '');

        let b = buckets.get(key);
        if (!b) {
            b = { sx: 0, sy: 0, sd: 0, sh: 0, n: 0, year: p.year };
            if (preserveOriginal) b.idx = [];
            buckets.set(key, b);
        }
        b.sx += x;
        b.sy += y;
        b.sd += p.deformation;
        b.sh += z;
        b.n++;
        if (preserveOriginal) b.idx.push(i);
    }

    for (const b of buckets.values()) {
        const inv = 1 / b.n;
        b.mx = b.sx * inv;
        b.my = b.sy * inv;
        b.mz = b.sh * inv;
        b.rep = null;
        b.repDist = Infinity;
    }

    for (let i = 0; i < data.length; i++) {
        const p = data[i];
        const x = p.longitude * mLon;
        const y = p.latitude * mLat;
        const z = p.height || 0;
        const key = Math.floor(x / voxelSize) + ',' + Math.floor(y / voxelSize) + ',' + Math.floor(z / voxelSize) + ',' + (p.year ?? '');
        const b = buckets.get(key);
        if (!b) continue;
        const dx = x - b.mx;
        const dy = y - b.my;
        const dz = z - b.mz;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist < b.repDist) {
            b.repDist = dist;
            b.rep = p;
        }
    }

    const out = new Array(buckets.size);
    let idx = 0;
    for (const b of buckets.values()) {
        const inv = 1 / b.n;
        const rep = b.rep || { longitude: (b.sx * inv) / mLon, latitude: (b.sy * inv) / mLat, height: b.sh * inv };
        const pt = attachGroundMetadata({
            longitude: rep.longitude,
            latitude: rep.latitude,
            deformation: b.sd * inv,
            height: rep.height || 0,
            groundHeight: Number.isFinite(Number(rep.groundHeight)) ? Number(rep.groundHeight) : (rep.height || 0),
            terrainExaggeration: rep.terrainExaggeration,
            year: b.year,                  
        }, rep.terrainExaggeration);
        if (preserveOriginal) pt.originalIndices = b.idx;
        out[idx++] = pt;
    }
    return out;
}

// =========================== Cesium Viewer初始化 ===========================
// 各层理想相机高度（米），对数均匀分布覆盖从街道到全球的完整缩放范围：
//   L0: 3km (极近 - 街道/详查)  L1: 30km (近 - 城市/局部)
//   L2: 200km (中 - 省域/地区)  L3: 900km (远 - 国域)  L4: 3000km (极远 - 全球)
// 相邻层切换阈值约为: ~10km, ~80km, ~420km, ~1650km
const VOXEL_LOD_IDEAL_HEIGHTS = [3000, 30000, 200000, 900000, 3000000];

export function buildVoxelLOD(data, options = {}) {
    const {
        baseVoxelSize = 10,        // 体素基础尺寸(m)，L0最精细
        levelCount = 5,            // 共5层，覆盖从极近到极远
        heightFactor = 0.05,       // 用于 levelCount != 5 时的回退公式
        preserveOriginal = false,
    } = options;

    if (!data || !data.length) return [];

    let sumLat = 0;
    for (let i = 0; i < data.length; i++) sumLat += data[i].latitude;
    const centerLatRad = (sumLat / data.length) * Math.PI / 180;
    const mLon = METERS_PER_DEG * Math.cos(centerLatRad);
    const mLat = METERS_PER_DEG;

    const PX = new Float64Array(data.length);
    const PY = new Float64Array(data.length);
    const PZ = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const p = data[i];
        PX[i] = p.longitude * mLon;
        PY[i] = p.latitude * mLat;
        PZ[i] = p.height || 0;
    }

    const levels = [];
    for (let l = 0; l < levelCount; l++) {
        const vs = baseVoxelSize * (1 << l); // 2^l
        // 优先使用预设对数分布高度，levelCount != 5 时回退到公式计算
        const idealH = (VOXEL_LOD_IDEAL_HEIGHTS[l] !== undefined)
            ? VOXEL_LOD_IDEAL_HEIGHTS[l]
            : vs / heightFactor;
        const bkts = new Map();

        for (let i = 0; i < data.length; i++) {
            const key = Math.floor(PX[i] / vs) + ',' + Math.floor(PY[i] / vs) + ',' + Math.floor(PZ[i] / vs) + ',' + (data[i].year ?? '');
            let b = bkts.get(key);
            if (!b) {
                b = { sx: PX[i], sy: PY[i], sd: data[i].deformation, sh: PZ[i], n: 1, year: data[i].year };
                if (preserveOriginal) b.idx = [i];
                bkts.set(key, b);
            } else {
                b.sx += PX[i]; b.sy += PY[i];
                b.sd += data[i].deformation; b.sh += PZ[i];
                b.n++;
                if (preserveOriginal) b.idx.push(i);
            }
        }

        for (const b of bkts.values()) {
            const inv = 1 / b.n;
            b.mx = b.sx * inv;
            b.my = b.sy * inv;
            b.mz = b.sh * inv;
            b.repIndex = -1;
            b.repDist = Infinity;
        }

        for (let i = 0; i < data.length; i++) {
            const key = Math.floor(PX[i] / vs) + ',' + Math.floor(PY[i] / vs) + ',' + Math.floor(PZ[i] / vs) + ',' + (data[i].year ?? '');
            const b = bkts.get(key);
            if (!b) continue;
            const dx = PX[i] - b.mx;
            const dy = PY[i] - b.my;
            const dz = PZ[i] - b.mz;
            const dist = dx * dx + dy * dy + dz * dz;
            if (dist < b.repDist) {
                b.repDist = dist;
                b.repIndex = i;
            }
        }

        const out = new Array(bkts.size);
        let idx = 0;
        for (const b of bkts.values()) {
            const inv = 1 / b.n;
            const rep = data[b.repIndex >= 0 ? b.repIndex : 0];
            const pt = attachGroundMetadata({
                longitude: rep.longitude,
                latitude: rep.latitude,
                deformation: b.sd * inv,
                height: rep.height || 0,
                groundHeight: Number.isFinite(Number(rep.groundHeight)) ? Number(rep.groundHeight) : (rep.height || 0),
                terrainExaggeration: rep.terrainExaggeration,
                year: b.year,              
            }, rep.terrainExaggeration);
            if (preserveOriginal) pt.originalIndices = b.idx;
            out[idx++] = pt;
        }

        levels.push({ level: l, voxelSize: vs, idealHeight: idealH, data: out });
    }
    return levels;
}

// =========================== LOD层级构建 ===========================
export function buildLODLevels(data) {
    const LOD_CONFIG = [
        { level: 0, maxDist: Infinity, minDist: 100000, label: '极远', voxelSize: 1000 },
        { level: 1, maxDist: 100000, minDist: 50000, label: '远', voxelSize: 500 },
        { level: 2, maxDist: 50000, minDist: 10000, label: '中', voxelSize: 100 },
        { level: 3, maxDist: 10000, minDist: 0, label: '近', voxelSize: 0 },
    ];
    return LOD_CONFIG.map(cfg => {
        const sampled = cfg.voxelSize > 0
            ? voxelGridDownsample(data, cfg.voxelSize, { preserveOriginal: false })
            : [...data];
        return {
            level: cfg.level, label: cfg.label,
            minDist: cfg.minDist, maxDist: cfg.maxDist,
            data: sampled, voxelSize: cfg.voxelSize,
            idealHeight: cfg.voxelSize / 0.025,
        };
    });
}

// =========================== LOD层级选择 ===========================
export function getLODLevel(h) {
    const LOD_CONFIG = [
        { level: 0, maxDist: Infinity, minDist: 100000 },
        { level: 1, maxDist: 100000, minDist: 50000 },
        { level: 2, maxDist: 50000, minDist: 10000 },
        { level: 3, maxDist: 10000, minDist: 0 },
    ];
    for (const c of LOD_CONFIG) { if (h >= c.minDist && h < c.maxDist) return c.level; }
    return LOD_CONFIG.length - 1;
}

// =========================== LOD 混合计算 ===========================
export function getVoxelLODLevel(cameraHeight, levels) {
    if (!levels || !levels.length) return 0;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < levels.length; i++) {
        const l = levels[i];
        const ideal = l.idealHeight != null ? l.idealHeight
            : (l.minDist != null && l.maxDist != null && isFinite(l.maxDist)) ? (l.minDist + l.maxDist) / 2
            : i * 10000;
        const d = Math.abs(cameraHeight - ideal);
        if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
}

// =========================== LOD 混合计算 ===========================
export function getBlendedLOD(cameraHeight, levels, threshold = 0.3) {
    if (!levels || levels.length === 0) return null;
    if (levels.length === 1) return { lower: 0, upper: 0, blend: 0 };

    const idx = getVoxelLODLevel(cameraHeight, levels);
    const ideal = levels[idx].idealHeight != null ? levels[idx].idealHeight
        : (idx > 0 ? levels[idx - 1].idealHeight * 2 : cameraHeight);

    let lower = idx, upper = idx, blend = 0;

    if (cameraHeight < ideal && idx > 0) {
        // 向下一个精细层 blend
        lower = idx - 1;
        upper = idx;
        const range = ideal - levels[lower].idealHeight;
        blend = range > 0 ? 1 - (ideal - cameraHeight) / range : 0;
    } else if (cameraHeight > ideal && idx < levels.length - 1) {
        // 向上一个粗糙层 blend
        lower = idx;
        upper = idx + 1;
        const range = levels[upper].idealHeight - ideal;
        blend = range > 0 ? (cameraHeight - ideal) / range : 0;
    }

    // threshold 内不做混合，避免性能开销
    if (blend < threshold) { lower = idx; upper = idx; blend = 0; }
    else if (blend > 1 - threshold) { lower = idx + (cameraHeight > ideal ? 1 : -1); upper = lower; blend = 0; }

    return { lower, upper, blend };
}
//测试函数
// =========================== 文件处理 ===========================
export function handleFiles(files, module) {
    const tParseStart = performance.now();   // 测试: 解析耗时计时起点
    if (!files.length) return;
    clearFile(module);
    const fileArray = Array.from(files);
    let processedCount = 0;
    let allValidData = [];
    const suffix = module === 'analysis' ? 'Analysis' : module === 'roam' ? 'Roam' : '';

    fileArray.forEach(file => {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['json', 'geojson', 'csv'].includes(ext)) {
            toast(`跳过不支持的文件: ${file.name}`, 'warning');
            processedCount++;
            if (processedCount === fileArray.length) finalizeFileProcessing(allValidData, module);
            return;
        }
        const reader = new FileReader();
        reader.onload = async e => {
            try {
                let raw = ext === 'csv' ? parseCSV(e.target.result) :
                    ext === 'geojson' ? parseGeoJSON(e.target.result) : parseJSON(e.target.result);
                if (!raw || !raw.length) { toast(`${file.name} 无有效数据`, 'error'); return; }
                let data = raw;
                const enableValidationEl = document.getElementById('enableValidation' + suffix);
                if (enableValidationEl && enableValidationEl.checked) {
                    const r = validateData(raw);
                    data = r.valid;
                    if (r.invalid.length) toast(`${file.name} 过滤 ${r.invalid.length} 无效点`, 'warning');
                }
                if (data.length > 0) {
                    allValidData = allValidData.concat(data);
                    if (!STATE.loadedFileNames.includes(file.name)) STATE.loadedFileNames.push(file.name);
                }
            } catch (err) { toast(`${file.name} 解析失败: ${err.message}`, 'error'); } finally {
                processedCount++;
                if (processedCount === fileArray.length) {
                console.log(`[解析耗时] ${(performance.now() - tParseStart).toFixed(0)} ms (共 ${allValidData.length} 点)`);   // 测试
                finalizeFileProcessing(allValidData, module);
            }
            }
        };
        reader.readAsText(file);
    });
}

function finalizeFileProcessing(validData, module) {
    const suffix = module === 'analysis' ? 'Analysis' : module === 'roam' ? 'Roam' : '';
    updateLoadedFilesUI(module);
    if (validData.length === 0) { toast('所有文件均无有效数据', 'error'); return; }
    STATE.parsedData = validData;
    const defs = validData.map(d => d.deformation);
    const previewEl = document.getElementById('dataPreview' + suffix);
    const statsGridEl = document.getElementById('statsGrid' + suffix);
    if (previewEl && statsGridEl) {
        previewEl.style.display = 'block';
        statsGridEl.innerHTML = `
            <div class="stat-card"><div class="num">${formatNumLocal(validData.length)}</div><div class="lbl">总有效点</div></div>
            <div class="stat-card"><div class="num">${STATE.loadedFileNames.length}</div><div class="lbl">已加载文件</div></div>
            <div class="stat-card"><div class="num">${arrayMin(defs).toFixed(3)}</div><div class="lbl">最小形变</div></div>
            <div class="stat-card"><div class="num">${arrayMax(defs).toFixed(3)}</div><div class="lbl">最大形变</div></div>
        `;
    }
    const terrainEl = document.getElementById('terrainSamplingGroup' + suffix);
    const validationEl = document.getElementById('dataValidationGroup' + suffix);
    const actionsEl = document.getElementById('actionButtons' + suffix);
    if (terrainEl) terrainEl.style.display = 'block';
    if (validationEl) validationEl.style.display = 'block';
    if (actionsEl) actionsEl.style.display = 'block';
    toast(`成功解析 ${validData.length} 个数据点`, 'success');
}

function formatNumLocal(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

// 加载完成后定位视角到数据最小边界矩形
function flyToDataExtent(data, duration = 1.8) {
    if (!viewer || !data || !data.length) return;

    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    for (const d of data) {
        if (d.longitude < minLng) minLng = d.longitude;
        if (d.longitude > maxLng) maxLng = d.longitude;
        if (d.latitude  < minLat) minLat = d.latitude;
        if (d.latitude  > maxLat) maxLat = d.latitude;
    }
    if (!isFinite(minLng) || !isFinite(maxLat)) return;

    // 四周留 15% 边距，防止数据贴边
    const lngPad = Math.max((maxLng - minLng) * 0.15, 0.005);
    const latPad = Math.max((maxLat - minLat) * 0.15, 0.005);

    try {
        viewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(
                minLng - lngPad, minLat - latPad,
                maxLng + lngPad, maxLat + latPad
            ),
            duration,
        });
    } catch (_) {
        // 兜底：中心点 + 根据跨度估算高度
        const cLng = (minLng + maxLng) / 2;
        const cLat = (minLat + maxLat) / 2;
        const spanDeg = Math.max(maxLng - minLng, (maxLat - minLat) * 1.4);
        const height = Math.max(5000, spanDeg * 111320 * 1.6);
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(cLng, cLat, height),
            duration,
        });
    }
}

export function clearFile(module) {
    const suffix = module === 'analysis' ? 'Analysis' : module === 'roam' ? 'Roam' : '';
    STATE.currentFile = null;
    STATE.parsedData = null;
    STATE.loadedFileNames = [];
    const infoEl = document.getElementById('fileInfoContainer' + suffix);
    const previewEl = document.getElementById('dataPreview' + suffix);
    const terrainEl = document.getElementById('terrainSamplingGroup' + suffix);
    const validationEl = document.getElementById('dataValidationGroup' + suffix);
    const actionsEl = document.getElementById('actionButtons' + suffix);
    const progressEl = document.getElementById('loadProgress' + suffix);
    const fileInputEl = document.getElementById('fileInput' + suffix);
    if (infoEl) infoEl.innerHTML = '';
    if (previewEl) previewEl.style.display = 'none';
    if (terrainEl) terrainEl.style.display = 'none';
    if (validationEl) validationEl.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';
    if (progressEl) progressEl.style.display = 'none';
    if (fileInputEl) fileInputEl.value = '';
    updateLoadedFilesUI(module);
}

// =========================== 加载数据到地图 ===========================
export async function loadDataToMap(module) {
    if (!STATE.parsedData || !STATE.parsedData.length) { toast('没有数据', 'warning'); return; }
    const tLoadStart = performance.now();   // 测试: 总加载耗时计时起点
    const suffix = module === 'analysis' ? 'Analysis' : module === 'roam' ? 'Roam' : '';
    const pe = document.getElementById('loadProgress' + suffix);
    const pf = document.getElementById('progressFill' + suffix);
    const pt = document.getElementById('progressText' + suffix);
    const pp = document.getElementById('progressPercent' + suffix);
    if (!pe) return;
    pe.style.display = 'block';
    try {
        let data = STATE.parsedData.map(d => withGroundHeightFromFile(d));
        const enableTerrainEl = document.getElementById('enableTerrainSampling' + suffix);
        if (enableTerrainEl) enableTerrainEl.checked = true;
        if (true) {
            if (pt) pt.textContent = '获取高程...';
            data = await sampleTerrainHeight(data, p => { if (pf) pf.style.width = (p * 100) + '%'; if (pp) pp.textContent = Math.round(p * 100) + '%'; });
            if (!data.length) throw new Error('未获取到有效高程：既没有成功获取 Cesium 地形采样，也没有可用的文件高程列，当前数据未加载');
        }
        const sourceCounts = data.reduce((acc, d) => {
            const key = d.groundHeightSource || 'unknown';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        if (sourceCounts.cesium) {
            toast(`Cesium 地形采样成功: ${sourceCounts.cesium} 点`, 'success');
        } else if (sourceCounts.file) {
            toast(`Cesium 地形暂不可用，已使用文件高程贴地: ${sourceCounts.file} 点`, 'warning');
        }
        if (pt) pt.textContent = '构建层级...';
        if (pf) pf.style.width = '60%';
        await new Promise(r => setTimeout(r, 50));
        const name = `数据集_${new Date().toLocaleString()}`;
        const { addDataset } = await import('./datasetManager.js');
        addDataset(name, data, { total: STATE.parsedData.length, valid: data.length, invalid: STATE.parsedData.length - data.length });
        if (pf) pf.style.width = '100%';
        if (pp) pp.textContent = '100%';
        if (pt) pt.textContent = '完成！';
        console.log(`[加载耗时] ${data.length} 点 → ${(performance.now() - tLoadStart).toFixed(0)} ms`);   // 测试
        toast(`加载成功！共 ${data.length} 点`, 'success');

        // 模块特定后处理
        if (!module) {
            document.getElementById('visControls').style.display = 'block';
            document.getElementById('dataPreview').style.display = 'none';
            document.getElementById('terrainSamplingGroup').style.display = 'none';
            document.getElementById('dataValidationGroup').style.display = 'none';
            document.getElementById('actionButtons').style.display = 'none';
            clearFile('');
        } else if (module === 'analysis') {
            document.getElementById('dataPreviewAnalysis').style.display = 'none';
            document.getElementById('terrainSamplingGroupAnalysis').style.display = 'none';
            document.getElementById('dataValidationGroupAnalysis').style.display = 'none';
            document.getElementById('actionButtonsAnalysis').style.display = 'none';
            clearFile('analysis');
        } else if (module === 'roam') {
            document.getElementById('dataPreviewRoam').style.display = 'none';
            document.getElementById('terrainSamplingGroupRoam').style.display = 'none';
            document.getElementById('dataValidationGroupRoam').style.display = 'none';
            document.getElementById('actionButtonsRoam').style.display = 'none';
            clearFile('roam');
        }

        // 定位视角到数据最小矩形边界（面板清理后再飞，视觉更流畅）
        flyToDataExtent(data);
    } catch (err) {
        console.error('loadDataToMap 失败:', err);
        toast(`加载失败: ${err.message}`, 'error');
        if (pf) pf.style.width = '0%';
        if (pp) pp.textContent = '0%';
        if (pt) pt.textContent = '加载失败';
        pe.style.display = 'none';
    }
}
