import { STATE, toast } from '../core/state.js';
import { viewer, scene } from '../core/viewer.js';
import { buildPntsBlob, buildTilesetJsonBlob, formatByteSize } from '../data/pntsBuilder.js';
import { getPointRenderHeight } from './heightModel.js';

let _tileset = null;
let _blobUrls = [];
let _lastDataHash = null;
let _cachedPntsResult = null;
let _cachedData = null;
let _serverTilesetId = null;
let _serverTilesetUrl = null;

let _appliedScheme = null;
let _appliedCMin = null;
let _appliedCMax = null;

let _restoreDepthTest = false;

function revokeBlobUrls() {
    for (const url of _blobUrls) URL.revokeObjectURL(url);
    _blobUrls = [];
}

function cleanup() {
    if (_tileset) {
        try { scene.primitives.remove(_tileset); } catch (e) {}
        _tileset = null;
    }
    revokeBlobUrls();
    _lastDataHash = null;
    _cachedPntsResult = null;
    _cachedData = null;
    _serverTilesetUrl = null;
    _appliedScheme = null;
    _appliedCMin = null;
    _appliedCMax = null;
    if (_restoreDepthTest && viewer?.scene?.globe) {
        viewer.scene.globe.depthTestAgainstTerrain = true;
        _restoreDepthTest = false;
    }
}

// =========================== 移除Tileset ===========================
export function removeTilesetCloud() {
    const idToDelete = _serverTilesetId;
    cleanup();
    _serverTilesetId = null;
    if (idToDelete) {
        void deleteServerTileset(idToDelete);
    }
}

function _t(cmin, cmax) {
    const range = cmax - cmin || 1;
    return `((${`$`}{deformation}-${cmin.toFixed(4)})/${range.toFixed(4)})`;
}

// =========================== 构建 pnts Blob ===========================
function buildStyleColorExpr(scheme, cmin, cmax) {
    const t = _t(cmin, cmax);
    switch (scheme) {
        case 'gray':
            return `hsla(0.0,0.0,clamp(${t}*0.84+0.08,0.0,1.0),1.0)`;
        case 'blue-white-red':
            return `hsla(clamp(240.0*(1.0-clamp(${t},0.0,1.0)),0.0,240.0),clamp(abs(clamp(${t},0.0,1.0)-0.5)*2.0,0.0,1.0),clamp(clamp(${t},0.0,1.0)*0.3+0.37,0.0,1.0),1.0)`;
        case 'blue-green-red':
            return `hsla(clamp(240.0*(1.0-clamp(${t},0.0,1.0)),0.0,240.0),clamp(0.85-abs(clamp(${t},0.0,1.0)-0.5)*0.3,0.0,1.0),0.50,1.0)`;
        case 'viridis':
            return `hsla(clamp(290.0-clamp(${t},0.0,1.0)*230.0,0.0,360.0),0.75,0.50,1.0)`;
        case 'thermal':
            return `hsla(clamp(280.0-clamp(${t},0.0,1.0)*230.0,0.0,360.0),0.92,clamp(clamp(${t},0.0,1.0)*0.38+0.25,0.0,1.0),1.0)`;
        case 'topo':
            return `hsla(clamp(120.0*(1.0-clamp(${t},0.0,1.0)),0.0,120.0),0.78,0.48,1.0)`;
        default:
            return `hsla(clamp(240.0*(1.0-clamp(${t},0.0,1.0)),0.0,240.0),clamp(abs(clamp(${t},0.0,1.0)-0.5)*2.0,0.0,1.0),0.55,1.0)`;
    }
}

// ============================ 创建样式 ============================
function createStyle(scheme, cmin, cmax) {
    let expr;
    try {
        expr = buildStyleColorExpr(scheme, cmin, cmax);
    } catch (e) {
        console.warn('[3D Tiles] style expression fallback:', e.message);
        expr = 'rgb(255,60,60)';
    }

    try {
        return new Cesium.Cesium3DTileStyle({
            color: expr,
            pointSize: STATE.pointSize ?? 8,
        });
    } catch (e) {
        console.error('[3D Tiles] style create failed:', e.message);
        return new Cesium.Cesium3DTileStyle({
            color: 'rgb(255,60,60)',
            pointSize: 12,
        });
    }
}

// =========================== 更新tiles样式 ===========================
export function updateTilesetStyle(colorScheme, cmin, cmax, pointSize) {
    if (!_tileset) return false;

    const needColorUpdate = colorScheme !== _appliedScheme ||
        Math.abs(cmin - _appliedCMin) > 0.001 ||
        Math.abs(cmax - _appliedCMax) > 0.001;

    if (!needColorUpdate) {
        if (pointSize != null) {
            try { _tileset.style.pointSize = pointSize; } catch (e) {}
        }
        return false;
    }

    const style = createStyle(colorScheme, cmin, cmax);
    if (pointSize != null) {
        try { style.pointSize = pointSize; } catch (e) {}
    }

    _tileset.style = style;
    _appliedScheme = colorScheme;
    _appliedCMin = cmin;
    _appliedCMax = cmax;
    return true;
}

// =========================== 更新tileset点大小 ===========================
export function updateTilesetPointSize(pointSize) {
    if (!_tileset) return;
    try { _tileset.style.pointSize = pointSize; } catch (e) {}
}

// =========================== 获取点云渲染高度 ===========================
function getRenderHeight(point) {
    return getPointRenderHeight(point, 0, STATE.terrainExaggeration);
}

function resolveTilesetUrl(url) {
    return new URL(url, window.location.href).toString();
}

// =========================== 加载Tileset ===========================
async function deleteServerTileset(id) {
    if (!id) return;
    try {
        await fetch(`/api/tilesets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
        console.warn('[3D Tiles] delete remote tileset failed:', err);
    }
}

// =========================== 创建服务器端Tileset ===========================
async function createServerTileset(data) {
    const response = await fetch('/api/tilesets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            points: data,
            options: {
                maxPointsPerTile: 80000,
                maxDepth: 8,
                geometricError: 1024,
            },
        }),
    });

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const payload = await response.json();
            if (payload?.error) message = payload.error;
        } catch (_) {}
        throw new Error(message);
    }

    return response.json();
}

// =========================== 加载Tileset ===========================
async function loadTilesetFromUrl(tilesetUrl) {
    return Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
        show: true,
        maximumScreenSpaceError: 1,
        skipLevelOfDetail: true,
        preferLeaves: true,
        immediatelyLoadDesiredLevelOfDetail: true,
        dynamicScreenSpaceError: false,
        cullWithChildrenBounds: false,
        cullRequestsWhileMoving: false,
        preloadWhenHidden: false,
        preloadFlightDestinations: false,
    });
}

// =========================== 使用tileset渲染 ===========================
function applyTilesetRenderingOptions(tileset) {
    if (!tileset) return;
    if (tileset.enableVerticalExaggeration !== undefined) {
        tileset.enableVerticalExaggeration = false;
    }
    if (viewer?.scene?.globe) {
        viewer.scene.globe.depthTestAgainstTerrain = true;
    }

    const cmin = STATE._colorMin ?? -10;
    const cmax = STATE._colorMax ?? 10;
    tileset.style = createStyle(STATE.colorScheme, cmin, cmax);
    try { tileset.style.pointSize = STATE.pointSize ?? 5; } catch (e) {}
    _appliedScheme = STATE.colorScheme;
    _appliedCMin = cmin;
    _appliedCMax = cmax;

    if (tileset.pointCloudShading) {
        tileset.pointCloudShading.attenuation = true;
        tileset.pointCloudShading.eyeDomeLighting = true;
        tileset.pointCloudShading.maximumAttenuation = 3;
        tileset.pointCloudShading.baseResolution = undefined;
    }

    tileset.backFaceCulling = false;
}

// =========================== 加载Tileset服务 ===========================
async function loadAsServerTileset(data, adjustedData) {
    const previousId = _serverTilesetId;
    const result = await createServerTileset(adjustedData);
    _serverTilesetId = result.id ?? null;
    _serverTilesetUrl = result.tilesetUrl ?? null;
    if (previousId) {
        void deleteServerTileset(previousId);
    }

    const tileset = await loadTilesetFromUrl(resolveTilesetUrl(result.tilesetUrl));
    scene.primitives.add(tileset);
    _tileset = tileset;
    applyTilesetRenderingOptions(tileset);

    _cachedData = data;
    _cachedPntsResult = {
        pointCount: result.stats?.pointCount ?? adjustedData.length,
        byteSize: result.stats?.byteLength ?? 0,
    };
    toast(`3D Tiles 加载完成: ${_cachedPntsResult.pointCount.toLocaleString()} 点 (${formatByteSize(_cachedPntsResult.byteSize || 0)})`, 'success');
    return tileset;
}

// =========================== 加载Tileset缓存数据 ===========================
async function loadAsMemoryTileset(data, adjustedData) {
    const pntsResult = buildPntsBlob(adjustedData);
    const pntsUrl = URL.createObjectURL(pntsResult.blob);
    _blobUrls.push(pntsUrl);

    const tilesetBlob = buildTilesetJsonBlob({
        pntsUrl,
        sphere: pntsResult.sphere,
        geometricError: 500,
    });
    const tilesetUrl = URL.createObjectURL(tilesetBlob);
    _blobUrls.push(tilesetUrl);

    const tileset = await loadTilesetFromUrl(tilesetUrl);
    scene.primitives.add(tileset);
    _tileset = tileset;
    applyTilesetRenderingOptions(tileset);

    _cachedData = data;
    _cachedPntsResult = pntsResult;
    toast(`3D Tiles 加载完成: ${pntsResult.pointCount.toLocaleString()} 点 (${formatByteSize(pntsResult.byteSize)})`, 'success');
    return tileset;
}

// =========================== 加载Tileset渲染 ===========================
export async function loadAsTileset(data) {
    const t0 = performance.now();
    cleanup();

    if (!data || !data.length) {
        toast('无数据可加载为 3D Tiles', 'warning');
        return null;
    }

    if (viewer?.scene?.globe) {
        viewer.scene.globe.depthTestAgainstTerrain = true;
        _restoreDepthTest = false;
    }

    const adjustedData = data.map(d => ({
        longitude: d.longitude,
        latitude: d.latitude,
        height: getRenderHeight(d),
        groundHeight: d.groundHeight,
        terrainExaggeration: STATE.terrainExaggeration,
        deformation: d.deformation,
        year: d.year,
    }));

    try {
        const tileset = await loadAsServerTileset(data, adjustedData);
        console.log(`[3D Tiles] built ${_cachedPntsResult?.pointCount ?? adjustedData.length} points via server in ${(performance.now() - t0).toFixed(0)}ms`);
        return tileset;
    } catch (err) {
        console.warn('[3D Tiles] server pipeline fallback:', err.message);
        try {
            const tileset = await loadAsMemoryTileset(data, adjustedData);
            console.log(`[3D Tiles] built ${_cachedPntsResult?.pointCount ?? adjustedData.length} points in-memory in ${(performance.now() - t0).toFixed(0)}ms`);
            return tileset;
        } catch (fallbackErr) {
            console.error('[3D Tiles] load failed:', fallbackErr);
            toast(`3D Tiles 加载失败: ${fallbackErr.message}`, 'error');
            cleanup();
            return null;
        }
    }
}

export function getCachedData() {
    return _cachedData;
}

export function getTileset() {
    return _tileset;
}

export function hasTileset() {
    return _tileset !== null;
}

export function syncTilesetVisibility(visible) {
    if (_tileset) _tileset.show = visible;
}

export function markDirty() {
    _lastDataHash = null;
}

export function dispose() {
    removeTilesetCloud();
}
