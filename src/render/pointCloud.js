// =========================== 点云渲染 (Primitive + 3D Tiles) ===========================
import { STATE, formatNum, toast } from '../core/state.js';
import { viewer, scene } from '../core/viewer.js';
import { deformationToColor } from './colorMap.js';
import { getVoxelLODLevel } from '../data/loader.js';
import { loadAsTileset, removeTilesetCloud, syncTilesetVisibility, hasTileset, updateTilesetStyle } from './pointCloudTiles.js';
import { getPointRenderHeight } from './heightModel.js';

const MAX_RENDER_POINTS = 2000000;
const LARGE_POINTCLOUD_THRESHOLD = 500000;

export let pointPrimitive = null;
let pickedPointCollection = null;
let _lastTilesDataHash = null;
let _tilesetLoading = false;

function getRenderHeight(point) {
    return getPointRenderHeight(point, 0, STATE.terrainExaggeration);
}

export function ensureCollections() {
    if (pointPrimitive) {
        try { scene.primitives.remove(pointPrimitive); pointPrimitive.destroy(); } catch (e) {}
        pointPrimitive = null;
    }
    removeTilesetCloud();
    _lastTilesDataHash = null;
}

// =========================== 创建点图元 ===========================
function createPointPrimitive(positions, colors, pixelSize) {
    const count = positions.length / 3;
    if (count === 0) return null;

    let size = Math.max(1, Math.min(pixelSize, 16));
    if (count > LARGE_POINTCLOUD_THRESHOLD) {
        size = Math.max(1, size * 0.6);
    }

    let needsBlend = false;
    for (let i = 3; i < colors.length; i += 4) {
        if (colors[i] < 0.999) {
            needsBlend = true;
            break;
        }
    }

    const collection = new Cesium.PointPrimitiveCollection({
        modelMatrix: Cesium.Matrix4.IDENTITY,
        blendOption: needsBlend ? Cesium.BlendOption.TRANSLUCENT : Cesium.BlendOption.OPAQUE,
    });

    const tStart = performance.now();
    for (let i = 0; i < count; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

        collection.add({
            position: new Cesium.Cartesian3(x, y, z),
            color: new Cesium.Color(colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2], colors[i * 4 + 3]),
            pixelSize: size,
            // 始终关闭地形深度裁剪：
            // depthTestAgainstTerrain=true 时，地形 LOD 面片会略高于数据点，
            // 低空飞行时会把整片点云裁掉；设为 Infinity 保证点云在任何高度都可见
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
    }

    if (collection.length === 0) {
        collection.destroy();
        return null;
    }

    if (count > LARGE_POINTCLOUD_THRESHOLD) {
        console.log(`[渲染] PointPrimitiveCollection 构建: ${collection.length}点 用时${(performance.now() - tStart).toFixed(0)}ms`);
    }
    return collection;
}

// =========================== 更新tileset数据路径 ===========================
async function updateTilesetPath(allPts, minDef, maxDef, filteredPts) {
    if (STATE._colorMin == null) STATE._colorMin = STATE.colorMin ?? minDef;
    if (STATE._colorMax == null) STATE._colorMax = STATE.colorMax ?? maxDef;

    const cmin = STATE._colorMin;
    const cmax = STATE._colorMax;
    const posHash = `${filteredPts.length}_${STATE.terrainExaggeration}`;

    if (posHash === _lastTilesDataHash && hasTileset()) {
        syncTilesetVisibility(STATE.pointCloudVisible);
        updateTilesetStyle(STATE.colorScheme, cmin, cmax, STATE.pointSize);
        updateLODDisplay(0, filteredPts.length, allPts.length,
            Cesium.Cartographic.fromCartesian(viewer.camera.position).height, 1);
        return;
    }

    if (_tilesetLoading) return;
    _tilesetLoading = true;
    removeTilesetCloud();
    _lastTilesDataHash = null;

    if (!filteredPts.length) {
        _tilesetLoading = false;
        return;
    }

    const tileset = await loadAsTileset(filteredPts);
    _tilesetLoading = false;
    if (tileset) {
        syncTilesetVisibility(STATE.pointCloudVisible);
        _lastTilesDataHash = posHash;
    }

    updateLODDisplay(0, filteredPts.length, allPts.length,
        Cesium.Cartographic.fromCartesian(viewer.camera.position).height, 1);
}

// =========================== 刷新点云显示 ===========================
export function updateVisualization() {
    if (!viewer || !scene) return;

    const vds = STATE.datasets.filter(d => d.visible && (d.voxelLevels || d.lodLevels || d.data));
    if (!vds.length) {
        ensureCollections();
        if (STATE.renderMode === 'tiles') {
            toast('3D Tiles 模式需要先加载数据，请上传 InSAR 数据文件', 'warning');
        }
        return;
    }

    const ch = Cesium.Cartographic.fromCartesian(viewer.camera.position).height;
    const refLevels = vds[0].voxelLevels || vds[0].lodLevels;
    const level = getVoxelLODLevel(ch, refLevels);
    STATE.cameraLevel = level;

    let minDef = Infinity;
    let maxDef = -Infinity;
    const allPts = [];

    for (const ds of vds) {
        let pts;
        if (STATE.fullDensityMode && Array.isArray(ds.data)) {
            pts = ds.data;
        } else {
            const levels = ds.voxelLevels || ds.lodLevels;
            const lod = levels[level];
            if (!lod) continue;
            pts = lod.data;
        }

        for (const d of pts) {
            allPts.push(d);
            if (d.deformation < minDef) minDef = d.deformation;
            if (d.deformation > maxDef) maxDef = d.deformation;
        }
    }

    if (!allPts.length) return;

    const filteredPts = [];
    const tf = allPts.length < 1000 ? null : STATE.timeFilter;
    for (const d of allPts) {
        if (!tf || String(d.year) === String(tf)) filteredPts.push(d);
    }

    if (minDef === maxDef) {
        minDef -= 0.1;
        maxDef += 0.1;
    }
    STATE._colorMin = STATE.colorMin ?? minDef;
    STATE._colorMax = STATE.colorMax ?? maxDef;

    if (STATE.renderMode === 'tiles') {
        updateTilesetPath(allPts, minDef, maxDef, filteredPts);
        return;
    }

    ensureCollections();


    const anomalyIndex = STATE.anomalyIndex;
    const anomalySet   = anomalyIndex ? null : new Set(STATE.anomalyPoints);
    const isAnomaly = anomalyIndex
        ? (d) => anomalyIndex.has(`${d.longitude.toFixed(5)},${d.latitude.toFixed(5)},${d.year ?? ''}`)
        : (d) => anomalySet.has(d);

    const ps = STATE.pointSize;
    const op = STATE.pointOpacity;
    const cmin = STATE._colorMin;
    const cmax = STATE._colorMax;
    let renderPts = [];

    if (STATE.pointCloudVisible) {
        renderPts = filteredPts;
        if (renderPts.length > MAX_RENDER_POINTS) {
            const step = Math.ceil(renderPts.length / MAX_RENDER_POINTS);
            renderPts = renderPts.filter((_, i) => i % step === 0).slice(0, MAX_RENDER_POINTS);
        }

        const count = renderPts.length;
        if (count > 0) {
            const positions = new Float64Array(count * 3);
            const colors = new Float32Array(count * 4);
            let idx = 0;

            for (const d of renderPts) {
                const h = getRenderHeight(d);
                const pos = Cesium.Cartesian3.fromDegrees(d.longitude, d.latitude, h);
                positions[idx * 3] = pos.x;
                positions[idx * 3 + 1] = pos.y;
                positions[idx * 3 + 2] = pos.z;

                if (isAnomaly(d)) {
                    const c = Cesium.Color.MAGENTA.withAlpha(op);
                    colors[idx * 4] = c.red;
                    colors[idx * 4 + 1] = c.green;
                    colors[idx * 4 + 2] = c.blue;
                    colors[idx * 4 + 3] = c.alpha;
                } else {
                    const color = deformationToColor(d.deformation, cmin, cmax);
                    color.alpha = op;
                    colors[idx * 4] = color.red;
                    colors[idx * 4 + 1] = color.green;
                    colors[idx * 4 + 2] = color.blue;
                    colors[idx * 4 + 3] = color.alpha;
                }
                idx++;
            }

            pointPrimitive = createPointPrimitive(positions, colors, ps);
            if (pointPrimitive) {
                try { scene.primitives.add(pointPrimitive); } catch (e) { console.warn('add pointPrimitive failed:', e); }
            }
        }
    }

    const renderedCount = renderPts ? renderPts.length : 0;
    const levelIdealH = refLevels[level]?.idealHeight ?? null;
    updateLODDisplay(level, renderedCount, allPts.length, ch, refLevels.length, levelIdealH);
    updateRenderStats(renderedCount);
}

// =========================== 重置点云显示状态 ===========================
function updateRenderStats(renderedCount) {
    const el = document.getElementById('renderStatsDisplay');
    if (!el) return;
    el.innerHTML = `
        <div class="row"><span class="key">点云(限制 ${formatNum(MAX_RENDER_POINTS)})</span><span class="val">${formatNum(renderedCount)}</span></div>
    `;
}

function _fmtHeight(h) {
    if (h == null || !isFinite(h)) return '';
    if (h >= 1e6) return (h / 1e6).toFixed(0) + 'Mm';
    if (h >= 1000) return (h / 1000).toFixed(0) + 'km';
    return Math.round(h) + 'm';
}

// levelIdealH: 当前层的 idealHeight（米），由调用方传入以保证准确
export function updateLODDisplay(l, v, t, h, totalLevels = 5, levelIdealH = null) {
    const el1 = document.getElementById('currentLevelDisplay');
    const el2 = document.getElementById('visiblePointsDisplay');
    const el3 = document.getElementById('totalPointsDisplay');
    const el4 = document.getElementById('cameraHeightDisplay');
    const levelLabel = levelIdealH != null ? _fmtHeight(levelIdealH) : `L${l}`;
    if (el1) el1.textContent = `L${l} · ${levelLabel}`;
    if (el2) el2.textContent = formatNum(v);
    if (el3) el3.textContent = formatNum(t || 0);
    if (el4) el4.textContent = h ? _fmtHeight(h) : '--';

    const segs = document.querySelectorAll('#lodBar .segment');
    if (segs.length > 0) {
        // l=0 为最精细层(极近), 对应最右侧; l=(n-1) 为最粗糙层(极远), 对应最左侧
        // barIdx=0 是最左段(极远), barIdx=(n-1) 是最右段(极近)
        const barIdx = Math.max(0, Math.min(segs.length - 1, segs.length - 1 - l));
        segs.forEach((s, i) => s.className = `segment ${i === barIdx ? 'active' : 'inactive'}`);
        const ind = document.getElementById('lodIndicator');
        if (ind) {
            const segWidth = 100 / segs.length;
            ind.style.left = (barIdx * segWidth + segWidth / 2) + '%';
        }
    }
}

// ========================== 获取点云高程 ===========================
export function highlightPickedPoint(point) {
    if (!point) {
        if (pickedPointCollection) {
            try { scene.primitives.remove(pickedPointCollection); } catch (e) {}
            pickedPointCollection = null;
        }
        return;
    }

    if (!pickedPointCollection) {
        pickedPointCollection = new Cesium.PointPrimitiveCollection();
    } else {
        pickedPointCollection.removeAll();
    }

    const h = getRenderHeight(point);
    try {
        const pos = Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, h);
        if (!pos || !isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) return;
        pickedPointCollection.add({
            position: pos,
            color: Cesium.Color.YELLOW,
            pixelSize: 20,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            disableDepthTestDistance: 0
        });
        pickedPointCollection.add({
            position: pos,
            color: Cesium.Color.YELLOW.withAlpha(0.25),
            pixelSize: 34,
            outlineWidth: 0,
            disableDepthTestDistance: 0
        });
        if (!scene.primitives.contains(pickedPointCollection)) {
            scene.primitives.add(pickedPointCollection);
        }
    } catch (e) {
        console.warn('highlightPickedPoint failed:', e);
    }
}
