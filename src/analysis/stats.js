// =========================== 区域边界分析 & 矢量底图 ===========================
import { STATE, BOUNDARY_LOD_CONFIG, VECTOR_MAP_SOURCES, vectorMapCache, toast, arrayMin, arrayMax } from '../core/state.js';
import { viewer, scene } from '../core/viewer.js';

// =========================== 矢量底图 ===========================
export function pointInPolygon(lng, lat, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

export function computeFeaturesPointPresence(features) {
    let allData = [];
    for (const ds of STATE.datasets) { if (ds.visible && ds.data) allData = allData.concat(ds.data); }
    if (!allData.length) { for (const f of features) f._hasPoints = false; return; }
    const tf = STATE.timeFilter;
    const searchData = tf ? allData.filter(d => String(d.year) === String(tf)) : allData;
    for (const f of features) {
        const coords = extractFeatureCoords(f);
        if (!coords || coords.length < 3) { f._hasPoints = false; continue; }
        let found = false;
        const step = Math.max(1, Math.floor(searchData.length / 2000));
        for (let i = 0; i < searchData.length; i += step) {
            const d = searchData[i];
            if (pointInPolygon(d.longitude, d.latitude, coords)) { found = true; break; }
        }
        f._hasPoints = found;
    }
}

export function extractFeatureCoords(feature) {
    const geom = feature.geometry;
    if (!geom) return null;
    if (geom.type === 'Polygon') return geom.coordinates[0] || null;
    if (geom.type === 'MultiPolygon') return geom.coordinates[0][0] || null;
    return null;
}

function getFeatureName(feature, source) {
    const p = feature.properties || {};
    return p['市'] || p['县'] || p['区'] || p['name'] || p['名称'] || (source ? source.nameKey : '') || '未命名';
}

function getFeatureCode(feature) {
    const p = feature.properties || {};
    return p['市代码'] || p['县代码'] || p['区代码'] || '';
}

export function processGeoJSONFeatures(json, fileKey, mapName) {
    let features = [];
    if (json.type === 'FeatureCollection') features = json.features || [];
    else if (json.type === 'Feature') features = [json];
    else throw new Error('不支持的 GeoJSON 类型');
    const source = VECTOR_MAP_SOURCES.find(s => s.file === fileKey);
    return features.filter(f => { const coords = extractFeatureCoords(f); return coords && coords.length >= 3; }).map(f => ({ ...f, _name: getFeatureName(f, source), _code: getFeatureCode(f) }));
}

export function showFeatureList(features, file, mapName) {
    if (STATE._boundaryFullCoordinates) {
        clearBoundaryInternal();
    }
    clearAllBoundaries();
    const container = document.getElementById('featureListContainer');
    const search = document.getElementById('featureSearch');
    const showAllBtn = document.getElementById('showAllBoundariesBtn');
    container.style.display = 'block';
    search.style.display = 'block';
    showAllBtn.style.display = 'inline-block';
    showAllBtn.textContent = '🌐 显示全部';
    showAllBtn.classList.remove('active-map');
    document.getElementById('featureListTitle').textContent = `📍 ${mapName}（选择区域）`;
    document.getElementById('featureCount').textContent = `${features.length} 个`;
    renderFeatureList(features, file);
    setTimeout(() => {
        computeFeaturesPointPresence(features);
        const currentFile = document.querySelector('.vector-map-btn.active-map')?.dataset.file;
        if (currentFile === file) {
            const sv = document.getElementById('featureSearchInput').value;
            renderFeatureList(features, file, sv);
        }
    }, 50);
}

export function renderFeatureList(features, file, filterText = '') {
    const list = document.getElementById('featureList');
    const q = filterText.trim().toLowerCase();
    const filtered = q ? features.filter(f => f._name.toLowerCase().includes(q)) : features;
    if (!filtered.length) { list.innerHTML = `<div class="empty-state">${q ? '无匹配区域' : '暂无数据'}</div>`; return; }
    list.innerHTML = filtered.map(f => {
        const code = f._code ? `<span class="feat-code">${f._code}</span>` : '';
        const hasPts = f._hasPoints;
        const badge = hasPts === undefined ? `<span class="feat-badge" style="opacity:0.4;">计算中...</span>` : (hasPts ? `<span class="feat-badge" style="background:rgba(0,200,100,0.15);color:#4cdb8a;">● 有点云</span>` : `<span class="feat-badge" style="background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.25);">○ 无数据</span>`);
        return `<div class="feat-item" data-file="${file}" data-idx="${features.indexOf(f)}"><span class="feat-name">${f._name}</span>${code}${badge}</div>`;
    }).join('');
    list.querySelectorAll('.feat-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            const feature = vectorMapCache[el.dataset.file]?.[idx];
            if (feature) loadBoundaryFromFeature(feature, el.dataset.file);
        });
    });
}

const vectorFileInput = document.createElement('input');
vectorFileInput.type = 'file';
vectorFileInput.accept = '.geojson,.json';
vectorFileInput.style.display = 'none';
vectorFileInput.id = 'vectorFileInput';
document.body.appendChild(vectorFileInput);

export async function loadVectorMap(btnEl) {
    const file = btnEl.dataset.file;
    const mapName = btnEl.dataset.name;
    const status = document.getElementById('vectorMapStatus');
    if (vectorMapCache[file]) {
        showFeatureList(vectorMapCache[file], file, mapName);
        document.querySelectorAll('.vector-map-btn').forEach(b => b.classList.remove('active-map'));
        btnEl.classList.add('active-map');
        status.innerHTML = `✅ ${mapName} 已加载，请选择区域`;
        return;
    }
    btnEl.textContent = '⏳ 加载中...';
    btnEl.disabled = true;
    status.innerHTML = `⏳ 正在加载 ${mapName}...`;
    try {
        const resp = await fetch(file);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const validFeatures = processGeoJSONFeatures(json, file, mapName);
        vectorMapCache[file] = validFeatures;
        btnEl.textContent = mapName;
        btnEl.classList.add('loaded');
        document.querySelectorAll('.vector-map-btn').forEach(b => b.classList.remove('active-map'));
        btnEl.classList.add('active-map');
        showFeatureList(validFeatures, file, mapName);
        status.innerHTML = `✅ ${mapName}：${validFeatures.length} 个区域（HTTP）`;
        toast(`✅ ${mapName} 加载成功！共 ${validFeatures.length} 个区域`, 'success');
        btnEl.disabled = false;
        return;
    } catch (fetchErr) { console.warn('fetch 失败：', fetchErr.message); }
    status.innerHTML = `ℹ️ ${mapName}：请选择对应的 GeoJSON 文件`;
    toast(`📂 请选择 ${mapName} 的 GeoJSON 文件`, 'info');
    btnEl.textContent = '📂 选择文件...';
    vectorFileInput.onchange = async function() {
        const selectedFile = vectorFileInput.files?.[0];
        if (!selectedFile) { btnEl.textContent = mapName; btnEl.disabled = false; status.innerHTML = '已取消选择'; return; }
        status.innerHTML = `⏳ 正在读取 ${selectedFile.name}...`;
        try {
            const text = await selectedFile.text();
            const json = JSON.parse(text);
            const validFeatures = processGeoJSONFeatures(json, file, mapName);
            vectorMapCache[file] = validFeatures;
            btnEl.textContent = mapName;
            btnEl.classList.add('loaded');
            document.querySelectorAll('.vector-map-btn').forEach(b => b.classList.remove('active-map'));
            btnEl.classList.add('active-map');
            showFeatureList(validFeatures, file, mapName);
            status.innerHTML = `✅ ${mapName}：${validFeatures.length} 个区域（本地文件）`;
            toast(`✅ ${mapName} 加载成功！共 ${validFeatures.length} 个区域`, 'success');
        } catch (err) { status.innerHTML = `❌ 文件解析失败：${err.message}`; toast(`❌ 解析失败：${err.message}`, 'error'); }
        finally { btnEl.disabled = false; vectorFileInput.value = ''; }
    };
    vectorFileInput.click();
}

export function loadBoundaryFromFeature(feature, file) {
    const coords = extractFeatureCoords(feature);
    if (!coords || coords.length < 3) { toast('要素无有效多边形', 'error'); return; }
    const name = feature._name || '未命名';
    clearBoundaryInternal();
    STATE._boundaryFullCoordinates = coords;
    STATE.boundaryCoordinates = coords;
    const fileInfo = document.getElementById('boundaryFileInfo');
    fileInfo.innerHTML = `<div class="file-info"><span class="name">🗺️ ${name}</span><span class="remove" data-action="clear-boundary">✕</span></div>`;
    fileInfo.querySelector('[data-action="clear-boundary"]').addEventListener('click', clearBoundary);
    renderBoundary();
    computeRegionStats(coords);
    toast(`✅ 已加载区域：${name}`, 'success');
    const lats = coords.map(c => c[1]), lngs = coords.map(c => c[0]);
    if (viewer?.camera) viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(arrayMin(lngs), arrayMin(lats), arrayMax(lngs), arrayMax(lats)), duration: 1.5 });
}

export function renderAllBoundaries(features) {
    clearAllBoundaries();
    if (!features || !features.length) return;
    const ids = [];
    const featherColor = Cesium.Color.CORNFLOWERBLUE.withAlpha(0.18);
    for (const f of features) {
        const coords = extractFeatureCoords(f);
        if (!coords || coords.length < 3) continue;
        const positions = coords.map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1]));
        try {
            const entity = viewer.entities.add({ polyline: { positions: [...positions, positions[0]], width: 1.2, material: featherColor, clampToGround: true } });
            ids.push(entity.id);
        } catch (e) {}
    }
    STATE._allBoundariesIds = ids;
    const btn = document.getElementById('showAllBoundariesBtn');
    btn.textContent = `🌐 全部 (${ids.length})`;
    btn.classList.add('active-map');
    toast(`🗺️ 已显示全部 ${ids.length} 个边界`, 'info');
}

export function clearAllBoundaries() {
    for (const id of STATE._allBoundariesIds) { try { viewer.entities.removeById(id); } catch (e) {} }
    STATE._allBoundariesIds = [];
    const btn = document.getElementById('showAllBoundariesBtn');
    btn.textContent = '🌐 显示全部';
    btn.classList.remove('active-map');
}

// --------------------------- 边界简化渲染 -----------------------
export function simplifyPolygonRing(coords, maxVertices) {
    if (!coords || coords.length < 3 || maxVertices === Infinity) return coords;
    if (coords.length <= maxVertices) return coords;
    const step = Math.max(1, Math.floor((coords.length - 1) / maxVertices));
    const result = [];
    for (let i = 0; i < coords.length - 1; i += step) result.push(coords[i]);
    result.push(coords[coords.length - 1]);
    return result;
}

function getPointCloudExtent() {
    let allData = [];
    for (const ds of STATE.datasets) if (ds.visible && ds.data) allData = allData.concat(ds.data);
    if (!allData.length) return null;
    const lngs = allData.map(d => d.longitude), lats = allData.map(d => d.latitude);
    return { minLng: arrayMin(lngs), maxLng: arrayMax(lngs), minLat: arrayMin(lats), maxLat: arrayMax(lats) };
}

function clipRingToExtent(coords, extent, marginDeg) {
    if (!extent || !coords || coords.length < 3) return coords;
    const e = { minLng: extent.minLng - marginDeg, maxLng: extent.maxLng + marginDeg, minLat: extent.minLat - marginDeg, maxLat: extent.maxLat + marginDeg };
    return coords.filter(c => c[0] >= e.minLng && c[0] <= e.maxLng && c[1] >= e.minLat && c[1] <= e.maxLat);
}

function getBoundaryLODLevel(height) {
    for (const c of BOUNDARY_LOD_CONFIG) { if (height >= c.minDist && height < c.maxDist) return c; }
    return BOUNDARY_LOD_CONFIG[BOUNDARY_LOD_CONFIG.length - 1];
}

export function renderBoundary() {
    if (!STATE._boundaryFullCoordinates || !viewer) return;
    const ch = Cesium.Cartographic.fromCartesian(viewer.camera.position).height;
    const lod = getBoundaryLODLevel(ch);
    STATE._boundaryLODLevel = lod.level;
    const margin = Math.max(0.2, ch * 0.003);
    const extent = getPointCloudExtent();
    let workingCoords = STATE._boundaryFullCoordinates;
    if (extent) { const clipped = clipRingToExtent(workingCoords, extent, margin); if (clipped.length >= 3) workingCoords = clipped; }
    if (lod.maxVertices !== Infinity) { workingCoords = simplifyPolygonRing(workingCoords, lod.maxVertices); }
    if (workingCoords.length < 3) {
        workingCoords = simplifyPolygonRing(STATE._boundaryFullCoordinates, Math.max(lod.maxVertices, 12));
        if (workingCoords.length < 3) return;
    }
    if (STATE._boundaryEntityId) { viewer.entities.removeById(STATE._boundaryEntityId); STATE._boundaryEntityId = null; }
    if (STATE._boundaryOutlineId) { viewer.entities.removeById(STATE._boundaryOutlineId); STATE._boundaryOutlineId = null; }
    const positions = workingCoords.map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1]));
    STATE.boundaryPolygons = positions;
    STATE.boundaryCoordinates = workingCoords;
    const fillEntity = viewer.entities.add({ polygon: { hierarchy: new Cesium.PolygonHierarchy(positions), material: Cesium.Color.CORNFLOWERBLUE.withAlpha(0.22), perPositionHeight: false, outline: false, height: 0 } });
    STATE._boundaryEntityId = fillEntity.id;
    const outlinePositions = [...positions, positions[0]];
    const outlineEntity = viewer.entities.add({ polyline: { positions: outlinePositions, width: Math.max(1.5, Math.min(4, 4 - lod.level)), material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.15, color: Cesium.Color.CORNFLOWERBLUE.withAlpha(0.85) }), clampToGround: true } });
    STATE._boundaryOutlineId = outlineEntity.id;
    const info = document.getElementById('boundaryInfoContainer');
    const origLen = STATE._boundaryFullCoordinates.length;
    const nowLen = workingCoords.length;
    const pct = Math.round(nowLen / origLen * 100);
    info.innerHTML = `<div class="boundary-info">🏔️ LOD:${lod.label} (${nowLen}/${origLen} 顶点 · ${pct}%)</div>`;
}

// =========================== 边界文件处理 ===========================
export function handleBoundaryFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const json = JSON.parse(e.target.result);
            let coordinates = [], features = [];
            if (json.type === 'FeatureCollection') features = json.features || [];
            else if (json.type === 'Feature') features = [json];
            else if (json.type === 'Polygon' || json.type === 'MultiPolygon') features = [{ geometry: json }];
            for (const feat of features) {
                const geom = feat.geometry;
                if (!geom) continue;
                if (geom.type === 'Polygon') { coordinates = geom.coordinates[0] || []; break; }
                if (geom.type === 'MultiPolygon') { coordinates = geom.coordinates[0][0] || []; break; }
            }
            if (!coordinates || coordinates.length < 3) throw new Error('未找到有效的面边界坐标');
            const fileInfo = document.getElementById('boundaryFileInfo');
            fileInfo.innerHTML = `<div class="file-info"><span class="name">🗺️ ${file.name}</span><span class="remove" data-action="clear-boundary">✕</span></div>`;
            fileInfo.querySelector('[data-action="clear-boundary"]').addEventListener('click', clearBoundary);
            STATE._boundaryFullCoordinates = coordinates;
            STATE.boundaryCoordinates = coordinates;
            renderBoundary();
            computeRegionStats(coordinates);
            toast('✅ 边界加载成功！', 'success');
            const lats = coordinates.map(c => c[1]), lngs = coordinates.map(c => c[0]);
            viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(arrayMin(lngs), arrayMin(lats), arrayMax(lngs), arrayMax(lats)), duration: 1.5 });
        } catch (err) { toast('❌ 边界解析失败：' + err.message, 'error'); console.error('解析错误：', err); }
    };
    reader.readAsText(file);
}

function clearBoundaryInternal() {
    STATE.boundaryPolygons = [];
    STATE.boundaryCoordinates = null;
    STATE._boundaryFullCoordinates = null;
    if (STATE._boundaryEntityId) { viewer.entities.removeById(STATE._boundaryEntityId); STATE._boundaryEntityId = null; }
    if (STATE._boundaryOutlineId) { viewer.entities.removeById(STATE._boundaryOutlineId); STATE._boundaryOutlineId = null; }
}

export function clearBoundary() {
    clearBoundaryInternal();
    document.getElementById('regionStats').style.display = 'none';
    document.getElementById('boundaryFileInfo').innerHTML = '';
    document.getElementById('boundaryInfoContainer').innerHTML = '';
    const boundaryFileInput = document.getElementById('boundaryFileInput');
    if (boundaryFileInput) boundaryFileInput.value = '';
    document.getElementById('regionStatsFloating').classList.remove('visible');
    toast('已清除边界', 'info');
}

// =========================== 区域统计 ===========================
export function computeRegionStats(coordinates, timeFilter) {
    const polyCoords = STATE._boundaryFullCoordinates || coordinates || STATE.boundaryCoordinates;
    if (!polyCoords || polyCoords.length < 3) {
        document.getElementById('regionStats').style.display = 'none';
        document.getElementById('regionStatsFloating').classList.remove('visible');
        return;
    }
    let allData = [];
    for (const ds of STATE.datasets) { if (ds.visible && ds.data) allData = allData.concat(ds.data); }
    const tf = timeFilter || STATE.timeFilter;
    if (tf) allData = allData.filter(d => String(d.year) === String(tf));
    const regionPoints = allData.filter(d => pointInPolygon(d.longitude, d.latitude, polyCoords));
    if (regionPoints.length === 0) {
        toast('所选区域内无数据点', 'warning');
        document.getElementById('regionStats').style.display = 'none';
        document.getElementById('regionStatsFloating').classList.remove('visible');
        return;
    }
    const defs = regionPoints.map(d => d.deformation);
    const mean = defs.reduce((a, b) => a + b, 0) / defs.length;
    const min = arrayMin(defs), max = arrayMax(defs);
    const std = Math.sqrt(defs.reduce((s, v) => s + (v - mean) ** 2, 0) / defs.length);
    document.getElementById('regionStats').style.display = 'block';
    document.getElementById('regionPointCount').textContent = regionPoints.length;
    document.getElementById('regionMean').textContent = mean.toFixed(4);
    document.getElementById('regionMinDef').textContent = min.toFixed(4);
    document.getElementById('regionMaxDef').textContent = max.toFixed(4);
    document.getElementById('regionStd').textContent = std.toFixed(4);
    const info = document.getElementById('boundaryInfoContainer');
    info.innerHTML = tf
        ? `<div class="boundary-info">📅 当前：${tf}  · 区域内 ${regionPoints.length} 点</div>`
        : `<div class="boundary-info">📍 区域内共 ${regionPoints.length} 个点</div>`;
    const rsf = document.getElementById('regionStatsFloating');
    document.getElementById('rsfMean').textContent = (mean >= 0 ? '+' : '') + mean.toFixed(4);
    document.getElementById('rsfMean').className = 'rsf-value ' + (mean >= 0 ? 'up' : 'down');
    document.getElementById('rsfMin').textContent = min.toFixed(4);
    document.getElementById('rsfMax').textContent = (max >= 0 ? '+' : '') + max.toFixed(4);
    document.getElementById('rsfInfo').textContent = `区域内点数: ${regionPoints.length}${tf ? `  ·  ${tf}` : ''}`;
    rsf.classList.add('visible');
    const lc = document.getElementById('lineChartContainer');
    rsf.style.bottom = lc.classList.contains('visible') ? '310px' : '20px';
}
