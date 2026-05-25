// =========================== IDW 插值 & 量化网格 TIN ===========================
// IDW (Inverse Distance Weighting) 插值 → Canvas 热力图叠加在 Cesium 上
// buildAdaptiveTIN 放在此处作为数据层；渲染层在 src/render/tin.js

import { STATE, toast, arrayMin, arrayMax } from '../core/state.js';

// ─── 内部工具 ────────────────────────────────────────────────────────────────
const METERS_PER_DEG = 111320;

/** 获取当前激活数据集的所有可见点（考虑时间过滤） */
export function getActivePoints() {
    const pts = [];
    for (const ds of STATE.datasets) {
        if (!ds.visible) continue;
        const src = ds.data || [];
        for (const p of src) {
            if (STATE.timeFilter && p.year != null && String(p.year) !== String(STATE.timeFilter)) continue;
            if (typeof p.longitude !== 'number' || typeof p.latitude !== 'number') continue;
            pts.push(p);
        }
    }
    return pts;
}

// ─── IDW 插值核心 ─────────────────────────────────────────────────────────────

/**
 * IDW 插值（async，空间分桶加速）
 * p 固定为 2，网格分辨率自动计算（上限 120），每 10 行 yield 防 UI 冻结
 * @param {Array}  pts     数据点 [{longitude, latitude, deformation}]
 * @param {object} options { colorScheme }  （其余参数内部自动决定）
 * @returns Promise<{ grid, cols, rows, minLng, maxLng, minLat, maxLat, minVal, maxVal }>
 */
export async function computeIDW(pts, options = {}) {
    if (!pts || pts.length < 3) throw new Error('IDW 至少需要 3 个数据点');

    const MAX_NEIGHBORS = 8;   // 最近邻数，够用且快
    const BUCKET_DIVS   = Math.max(8, Math.min(40, Math.ceil(Math.sqrt(pts.length) / 2)));
    // 网格上限 120×120（max ~14400 格），空间分桶后每格 O(k) 不再 O(n)
    const autoSize = Math.max(40, Math.min(120, Math.ceil(Math.sqrt(pts.length) * 0.9)));
    const gridCols = autoSize;
    const gridRows = autoSize;

    // ── 数据范围 ──────────────────────────────────────────────────────────────
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of pts) {
        if (p.longitude < minLng) minLng = p.longitude;
        if (p.longitude > maxLng) maxLng = p.longitude;
        if (p.latitude  < minLat) minLat = p.latitude;
        if (p.latitude  > maxLat) maxLat = p.latitude;
    }
    const padLng = Math.max((maxLng - minLng) * 0.02, 0.001);
    const padLat = Math.max((maxLat - minLat) * 0.02, 0.001);
    minLng -= padLng; maxLng += padLng;
    minLat -= padLat; maxLat += padLat;

    // ── 投影到米坐标 ──────────────────────────────────────────────────────────
    const centerLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(centerLat * Math.PI / 180);
    const mLon = METERS_PER_DEG * cosLat;
    const mLat_m = METERS_PER_DEG;

    const n = pts.length;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const pv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        px[i] = pts[i].longitude * mLon;
        py[i] = pts[i].latitude  * mLat_m;
        pv[i] = pts[i].deformation;
    }

    // ── 空间分桶索引 ──────────────────────────────────────────────────────────
    const minX = minLng * mLon,  maxX = maxLng * mLon;
    const minY = minLat * mLat_m, maxY = maxLat * mLat_m;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const bucketW = spanX / BUCKET_DIVS;
    const bucketH = spanY / BUCKET_DIVS;

    // 一维桶数组
    const bucketGrid = new Array(BUCKET_DIVS * BUCKET_DIVS).fill(null);
    for (let i = 0; i < n; i++) {
        const bx = Math.max(0, Math.min(BUCKET_DIVS - 1, Math.floor((px[i] - minX) / bucketW)));
        const by = Math.max(0, Math.min(BUCKET_DIVS - 1, Math.floor((py[i] - minY) / bucketH)));
        const idx = by * BUCKET_DIVS + bx;
        if (!bucketGrid[idx]) bucketGrid[idx] = [];
        bucketGrid[idx].push(i);
    }

    // 搜索半径（桶数）：取能覆盖 MAX_NEIGHBORS 个点的最小半径，最少搜 2 圈
    const SEARCH_R = Math.max(2, Math.ceil(Math.sqrt(MAX_NEIGHBORS / (n / (BUCKET_DIVS * BUCKET_DIVS) || 1))));

    // ── 插值计算（async，每 10 行 yield）────────────────────────────────────
    const stepLng = (maxLng - minLng) / gridCols;
    const stepLat = (maxLat - minLat) / gridRows;
    const grid = new Float32Array(gridCols * gridRows);
    let minVal = Infinity, maxVal = -Infinity;

    for (let r = 0; r < gridRows; r++) {
        // 每 10 行让出主线程，防止 UI 冻结
        if (r % 10 === 0) await new Promise(res => setTimeout(res, 0));

        const gLat = minLat + (r + 0.5) * stepLat;
        const gy   = gLat * mLat_m;
        const gBY  = Math.max(0, Math.min(BUCKET_DIVS - 1, Math.floor((gy - minY) / bucketH)));

        for (let c = 0; c < gridCols; c++) {
            const gLng = minLng + (c + 0.5) * stepLng;
            const gx   = gLng * mLon;
            const gBX  = Math.max(0, Math.min(BUCKET_DIVS - 1, Math.floor((gx - minX) / bucketW)));

            // 收集邻近桶中的候选点
            let exactVal = NaN;
            let found = false;
            const cands = [];

            outer:
            for (let dy = -SEARCH_R; dy <= SEARCH_R; dy++) {
                const by2 = gBY + dy;
                if (by2 < 0 || by2 >= BUCKET_DIVS) continue;
                for (let dx = -SEARCH_R; dx <= SEARCH_R; dx++) {
                    const bx2 = gBX + dx;
                    if (bx2 < 0 || bx2 >= BUCKET_DIVS) continue;
                    const arr = bucketGrid[by2 * BUCKET_DIVS + bx2];
                    if (!arr) continue;
                    for (const i of arr) {
                        const ddx = gx - px[i], ddy = gy - py[i];
                        const d2  = ddx * ddx + ddy * ddy;
                        if (d2 < 1e-8) { exactVal = pv[i]; found = true; break outer; }
                        cands.push(d2, pv[i]); // 交替存 d2, v（减少对象分配）
                    }
                }
            }

            let val;
            if (found) {
                val = exactVal;
            } else if (!cands.length) {
                val = NaN;
            } else {
                // cands 是 [d2_0, v_0, d2_1, v_1, ...]
                // 取最近 MAX_NEIGHBORS 个（选出最小 d2 对应 v）
                const count = cands.length / 2;
                let wsum = 0, vsum = 0;
                if (count <= MAX_NEIGHBORS) {
                    for (let j = 0; j < cands.length; j += 2) {
                        const w = 1.0 / cands[j]; // p=2，w = 1/d^2
                        wsum += w; vsum += w * cands[j + 1];
                    }
                } else {
                    // 部分排序：取前 MAX_NEIGHBORS 最小 d2
                    // 用简单最小堆思路：维护一个固定大小数组
                    const heap = new Float64Array(MAX_NEIGHBORS * 2).fill(Infinity);
                    let maxD2InHeap = Infinity;
                    for (let j = 0; j < cands.length; j += 2) {
                        const d2 = cands[j];
                        if (d2 < maxD2InHeap) {
                            // 找堆中最大 d2 并替换
                            let maxIdx = 0;
                            maxD2InHeap = heap[0];
                            for (let k = 2; k < heap.length; k += 2) {
                                if (heap[k] > maxD2InHeap) { maxD2InHeap = heap[k]; maxIdx = k; }
                            }
                            if (d2 < maxD2InHeap) {
                                heap[maxIdx] = d2;
                                heap[maxIdx + 1] = cands[j + 1];
                                // 更新 maxD2InHeap
                                maxD2InHeap = heap[0];
                                for (let k = 2; k < heap.length; k += 2) {
                                    if (heap[k] > maxD2InHeap) maxD2InHeap = heap[k];
                                }
                            }
                        }
                    }
                    for (let k = 0; k < heap.length; k += 2) {
                        if (!isFinite(heap[k])) continue;
                        const w = 1.0 / heap[k];
                        wsum += w; vsum += w * heap[k + 1];
                    }
                }
                val = wsum > 0 ? vsum / wsum : NaN;
            }

            grid[r * gridCols + c] = val;
            if (isFinite(val)) {
                if (val < minVal) minVal = val;
                if (val > maxVal) maxVal = val;
            }
        }
    }

    return { grid, cols: gridCols, rows: gridRows, minLng, maxLng, minLat, maxLat, minVal, maxVal };
}

/**
 * 将 IDW 网格渲染为 Canvas → ImageData（RGBA），使用指定色带
 * NaN 区域 alpha=0（透明），有效值区域 alpha=220（半透明叠加）
 */
export function idwGridToCanvas(result, options = {}) {
    const { grid, cols, rows, minVal, maxVal } = result;
    const { colorScheme = STATE.colorScheme || 'blue-white-red' } = options;
    const alpha = 220; // 固定透明度，无需外部控制

    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(cols, rows);
    const data = imgData.data;

    const range = maxVal - minVal || 1;

    for (let i = 0; i < grid.length; i++) {
        const v = grid[i];
        const base = i * 4;
        if (!isFinite(v)) {
            data[base + 3] = 0; // 透明
            continue;
        }
        const t = (v - minVal) / range; // 0~1
        const [r, g, b] = sampleColorScheme(t, colorScheme);
        data[base]     = r;
        data[base + 1] = g;
        data[base + 2] = b;
        data[base + 3] = alpha;
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

/** 色带采样：t ∈ [0,1] → [r,g,b] 0~255 */
function sampleColorScheme(t, scheme) {
    const stops = COLOR_STOPS[scheme] || COLOR_STOPS['blue-white-red'];
    // 找两侧 stop 线性插值
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const s0 = stops[i - 1], s1 = stops[i];
            const f = (t - s0[0]) / (s1[0] - s0[0] || 1);
            return [
                Math.round(s0[1] + (s1[1] - s0[1]) * f),
                Math.round(s0[2] + (s1[2] - s0[2]) * f),
                Math.round(s0[3] + (s1[3] - s0[3]) * f),
            ];
        }
    }
    const last = stops[stops.length - 1];
    return [last[1], last[2], last[3]];
}

const COLOR_STOPS = {
    'blue-white-red': [
        [0.0,  30,  81, 171],
        [0.25, 109, 164, 220],
        [0.5,  245, 245, 245],
        [0.75, 230, 100,  80],
        [1.0,  170,  30,  30],
    ],
    'viridis': [
        [0.0,  68,   1, 84],
        [0.25, 59,  82, 139],
        [0.5,  33, 145, 140],
        [0.75, 94, 201,  98],
        [1.0,  253, 231, 37],
    ],
    'thermal': [
        [0.0,  13,   8, 135],
        [0.25, 126,   3, 168],
        [0.5,  204,  70, 120],
        [0.75, 248, 148, 65],
        [1.0,  240, 249, 33],
    ],
    'topo': [
        [0.0,    0, 104,  55],
        [0.25,  26, 152, 80],
        [0.5,  166, 217, 106],
        [0.75, 253, 174,  97],
        [1.0,  165,  0,  38],
    ],
};

// ─── 量化网格自适应 TIN ────────────────────────────────────────────────────────

/**
 * 量化网格自适应 Delaunay TIN（纯 JS 实现）
 *
 * 流程：
 *  1. 将点云量化到规则网格（cellSize 米），每格取代表点（均值形变）
 *  2. 在量化点上运行 Bowyer-Watson Delaunay 三角剖分
 *  3. 过滤掉外接圆超过 maxEdgeM 米的"超长"三角（空洞边缘伪三角）
 *
 * @param {Array}  pts       数据点 [{longitude, latitude, deformation, height?}]
 * @param {object} options
 *   cellSize   : 量化格尺寸（米），默认自适应 = 数据范围 / 80
 *   maxEdge    : 最大允许三角边（米），默认 = cellSize * 5
 * @returns { vertices: [{lng, lat, def, h}], triangles: [[i0,i1,i2], ...] }
 */
export function buildAdaptiveTIN(pts, options = {}) {
    if (!pts || pts.length < 3) throw new Error('TIN 至少需要 3 个数据点');

    // ── 投影参数
    let sumLat = 0;
    for (const p of pts) sumLat += p.latitude;
    const centerLat = sumLat / pts.length;
    const cosLat = Math.cos(centerLat * Math.PI / 180);
    const mLon = METERS_PER_DEG * cosLat;
    const mLat = METERS_PER_DEG;

    // ── 数据范围
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
        const x = p.longitude * mLon, y = p.latitude * mLat;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const defaultCell = Math.max(spanX, spanY) / 80;
    const cellSize = options.cellSize || defaultCell;
    const maxEdgeM = options.maxEdge || cellSize * 5;

    // ── 量化网格：每格聚合均值
    const cells = new Map();
    for (const p of pts) {
        const x = p.longitude * mLon;
        const y = p.latitude  * mLat;
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        const key = cx + ',' + cy;
        let c = cells.get(key);
        if (!c) {
            c = { sx: 0, sy: 0, sd: 0, sh: 0, n: 0 };
            cells.set(key, c);
        }
        c.sx += p.longitude; c.sy += p.latitude;
        c.sd += p.deformation; c.sh += (p.height || 0); c.n++;
    }

    // ── 顶点列表
    const verts = [];
    for (const c of cells.values()) {
        const inv = 1 / c.n;
        verts.push({
            lng: c.sx * inv,
            lat: c.sy * inv,
            def: c.sd * inv,
            h:   c.sh * inv,
            // 投影坐标（内部用）
            x: (c.sx * inv) * mLon,
            y: (c.sy * inv) * mLat,
        });
    }
    if (verts.length < 3) throw new Error('量化后顶点不足 3 个，请减小 cellSize');

    // ── Bowyer-Watson Delaunay 三角剖分
    const tris = bowyerWatson(verts);

    // ── 过滤超长三角（伪三角）
    const maxEdge2 = maxEdgeM * maxEdgeM;
    const filtered = tris.filter(([i0, i1, i2]) => {
        const v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
        return (
            edgeSq(v0, v1) <= maxEdge2 &&
            edgeSq(v1, v2) <= maxEdge2 &&
            edgeSq(v2, v0) <= maxEdge2
        );
    });

    // 清理内部投影字段，只保留地理信息
    for (const v of verts) { delete v.x; delete v.y; }

    return { vertices: verts, triangles: filtered };
}

function edgeSq(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function bowyerWatson(verts) {
    const n = verts.length;

    // 超级三角形：覆盖所有点
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of verts) {
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    const dx = (maxX - minX) * 10, dy = (maxY - minY) * 10;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const R = Math.max(dx, dy) + 1;

    // 超级三角形顶点追加到末尾
    const sv0 = { x: cx,     y: cy + 2 * R };
    const sv1 = { x: cx - 2 * R, y: cy - R };
    const sv2 = { x: cx + 2 * R, y: cy - R };
    const all = [...verts, sv0, sv1, sv2];
    const sI = [n, n + 1, n + 2];

    // 三角列表：每个三角存 [i0, i1, i2]
    let triangles = [[n, n + 1, n + 2]];

    for (let pi = 0; pi < n; pi++) {
        const p = all[pi];

        // 找到外接圆包含 p 的三角
        const bad = [];
        for (const tri of triangles) {
            if (inCircumcircle(all[tri[0]], all[tri[1]], all[tri[2]], p)) {
                bad.push(tri);
            }
        }

        // 找到 bad 集合的边界多边形（非共享边）
        const boundary = [];
        for (const tri of bad) {
            for (let e = 0; e < 3; e++) {
                const ea = tri[e], eb = tri[(e + 1) % 3];
                let shared = false;
                for (const other of bad) {
                    if (other === tri) continue;
                    for (let f = 0; f < 3; f++) {
                        const fa = other[f], fb = other[(f + 1) % 3];
                        if ((ea === fa && eb === fb) || (ea === fb && eb === fa)) {
                            shared = true; break;
                        }
                    }
                    if (shared) break;
                }
                if (!shared) boundary.push([ea, eb]);
            }
        }

        // 删除 bad 三角
        triangles = triangles.filter(t => !bad.includes(t));

        // 以 p 和边界各边形成新三角
        for (const [ea, eb] of boundary) {
            triangles.push([pi, ea, eb]);
        }
    }

    // 删除包含超级三角形顶点的三角
    triangles = triangles.filter(([i0, i1, i2]) =>
        !sI.includes(i0) && !sI.includes(i1) && !sI.includes(i2)
    );

    return triangles;
}

function inCircumcircle(a, b, c, p) {
    const ax = a.x - p.x, ay = a.y - p.y;
    const bx = b.x - p.x, by = b.y - p.y;
    const cx = c.x - p.x, cy = c.y - p.y;
    const det = ax * (by * (cx * cx + cy * cy) - cy * (bx * bx + by * by))
              - ay * (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by))
              + (ax * ax + ay * ay) * (bx * cy - by * cx);
    return det > 0;
}
