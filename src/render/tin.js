// =========================== TIN & IDW Cesium 渲染层 ===========================

import { viewer } from '../core/viewer.js';
import { STATE, toast } from '../core/state.js';
import { computeIDW, idwGridToCanvas, buildAdaptiveTIN, getActivePoints } from '../analysis/interpolation.js';

// ─── 模块级句柄 ──────────────────────────────────────────────────────────────
let _idwEntity    = null;   // Cesium Entity（矩形色栅格）
let _tinPrimitive = null;   // Cesium Primitive（三角面片）
let _tinEdges     = null;   // Cesium Primitive（线框，可选）

// ─── IDW 热力图 ──────────────────────────────────────────────────────────────

/**
 * 生成并叠加 IDW 热力图（async）。
 * 使用 Cesium Entity + ImageMaterialProperty 方式，完全离线，无网络请求。
 * @param {object} options  { colorScheme }
 */
export async function renderIDWHeatmap(options = {}) {
    removeIDWLayer();
    const pts = getActivePoints();
    if (!pts.length) { toast('没有可用数据点', 'warning'); return null; }

    let result;
    try {
        result = await computeIDW(pts, {
            colorScheme: options.colorScheme || STATE.colorScheme || 'blue-white-red',
        });
    } catch (e) {
        toast('IDW 计算失败: ' + e.message, 'error');
        return null;
    }

    // 将网格渲染为 Canvas（不透明，Entity 层级覆盖）
    const canvas = idwGridToCanvas(result, {
        colorScheme: options.colorScheme || STATE.colorScheme || 'blue-white-red',
    });

    const { minLng, maxLng, minLat, maxLat } = result;

    // 用 Entity 矩形 + canvas 材质叠加，不依赖 ImageryProvider 服务
    _idwEntity = viewer.entities.add({
        rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(minLng, minLat, maxLng, maxLat),
            material: new Cesium.ImageMaterialProperty({
                image: canvas,
                transparent: true,   // 让 NaN 像素（alpha=0）穿透
                repeat: new Cesium.Cartesian2(1.0, 1.0),
            }),
            height: 200,             // 略高于地面，防止 z-fighting
            classificationType: Cesium.ClassificationType.TERRAIN,
        },
    });

    toast(`IDW 热力图已生成（${result.cols}×${result.rows} 网格）`, 'success');
    return result;
}

export function removeIDWLayer() {
    if (_idwEntity) {
        try { viewer.entities.remove(_idwEntity); } catch (_) {}
        _idwEntity = null;
    }
}

export function hasIDWLayer() { return !!_idwEntity; }

// ─── TIN 三角网 ──────────────────────────────────────────────────────────────

/**
 * 构建并渲染自适应 TIN（Cesium Primitive 三角面片）
 * @param {object} options  { cellSize, showEdges, edgeColor, colorScheme, colorMin, colorMax, exaggeration }
 */
export function renderTIN(options = {}) {
    removeTINPrimitive();
    const pts = getActivePoints();
    if (!pts.length) { toast('没有可用数据点', 'warning'); return null; }

    let tinResult;
    try {
        tinResult = buildAdaptiveTIN(pts, options);
    } catch (e) {
        toast('TIN 构建失败: ' + e.message, 'error');
        return null;
    }

    const { vertices, triangles } = tinResult;
    if (!triangles.length) {
        toast('TIN 无有效三角（数据点分布过稀）', 'warning');
        return null;
    }

    // 形变色带
    const scheme = options.colorScheme || STATE.colorScheme || 'blue-white-red';
    const defs   = vertices.map(v => v.def);
    const minDef = options.colorMin ?? Math.min(...defs);
    const maxDef = options.colorMax ?? Math.max(...defs);
    const range  = maxDef - minDef || 1;
    const exag   = options.exaggeration ?? STATE.exaggeration ?? 1;

    const OPACITY = 0.85;

    const instances = [];
    for (const [i0, i1, i2] of triangles) {
        const v0 = vertices[i0], v1 = vertices[i1], v2 = vertices[i2];
        const avgDef = (v0.def + v1.def + v2.def) / 3;
        const t = Math.max(0, Math.min(1, (avgDef - minDef) / range));
        const [r, g, b] = sampleStop(t, scheme);

        const h0 = (v0.h || 0) + v0.def * exag;
        const h1 = (v1.h || 0) + v1.def * exag;
        const h2 = (v2.h || 0) + v2.def * exag;

        let geo;
        try {
            geo = new Cesium.PolygonGeometry({
                polygonHierarchy: new Cesium.PolygonHierarchy(
                    Cesium.Cartesian3.fromDegreesArrayHeights([
                        v0.lng, v0.lat, h0,
                        v1.lng, v1.lat, h1,
                        v2.lng, v2.lat, h2,
                    ])
                ),
                perPositionHeight: true,
            });
        } catch (_) { continue; }

        instances.push(new Cesium.GeometryInstance({
            geometry: geo,
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    new Cesium.Color(r / 255, g / 255, b / 255, OPACITY)
                ),
            },
        }));
    }

    if (!instances.length) {
        toast('TIN 三角面构建异常（无有效实例）', 'warning');
        return null;
    }

    _tinPrimitive = viewer.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
            flat: false,
            translucent: OPACITY < 1,
        }),
        asynchronous: false,
    }));

    if (options.showEdges) {
        const edgeInstances = [];
        const ec = Cesium.Color.WHITE.withAlpha(0.30);
        for (const [i0, i1, i2] of triangles) {
            const v0 = vertices[i0], v1 = vertices[i1], v2 = vertices[i2];
            const h0 = (v0.h || 0) + v0.def * exag;
            const h1 = (v1.h || 0) + v1.def * exag;
            const h2 = (v2.h || 0) + v2.def * exag;
            edgeInstances.push(new Cesium.GeometryInstance({
                geometry: new Cesium.SimplePolylineGeometry({
                    positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                        v0.lng, v0.lat, h0,
                        v1.lng, v1.lat, h1,
                        v2.lng, v2.lat, h2,
                        v0.lng, v0.lat, h0,
                    ]),
                }),
                attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(ec) },
            }));
        }
        if (edgeInstances.length) {
            _tinEdges = viewer.scene.primitives.add(new Cesium.Primitive({
                geometryInstances: edgeInstances,
                appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
                asynchronous: false,
            }));
        }
    }

    toast(`TIN 已渲染：${vertices.length} 顶点 · ${triangles.length} 三角`, 'success');
    return tinResult;
}

export function removeTINPrimitive() {
    if (_tinPrimitive) {
        try { viewer.scene.primitives.remove(_tinPrimitive); } catch (_) {}
        _tinPrimitive = null;
    }
    if (_tinEdges) {
        try { viewer.scene.primitives.remove(_tinEdges); } catch (_) {}
        _tinEdges = null;
    }
}

export function hasTINPrimitive() { return !!_tinPrimitive; }

const COLOR_STOPS = {
    'blue-white-red': [[0,[30,81,171]],[0.25,[109,164,220]],[0.5,[245,245,245]],[0.75,[230,100,80]],[1,[170,30,30]]],
    'viridis':        [[0,[68,1,84]],[0.25,[59,82,139]],[0.5,[33,145,140]],[0.75,[94,201,98]],[1,[253,231,37]]],
    'thermal':        [[0,[13,8,135]],[0.25,[126,3,168]],[0.5,[204,70,120]],[0.75,[248,148,65]],[1,[240,249,33]]],
    'topo':           [[0,[0,104,55]],[0.25,[26,152,80]],[0.5,[166,217,106]],[0.75,[253,174,97]],[1,[165,0,38]]],
    'blue-green-red': [[0,[30,58,138]],[0.25,[34,211,238]],[0.5,[134,239,172]],[0.75,[254,240,138]],[1,[220,38,38]]],
    'gray':           [[0,[17,17,17]],[0.5,[153,153,153]],[1,[238,238,238]]],
};

function sampleStop(t, scheme) {
    const stops = COLOR_STOPS[scheme] || COLOR_STOPS['blue-white-red'];
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
            const f = (t - t0) / ((t1 - t0) || 1);
            return [
                Math.round(c0[0] + (c1[0] - c0[0]) * f),
                Math.round(c0[1] + (c1[1] - c0[1]) * f),
                Math.round(c0[2] + (c1[2] - c0[2]) * f),
            ];
        }
    }
    return stops[stops.length - 1][1];
}
