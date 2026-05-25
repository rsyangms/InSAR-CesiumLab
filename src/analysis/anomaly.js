// =========================== 异常变形检测 ===========================
import { STATE, toast } from '../core/state.js';
import { updateVisualization } from '../render/pointCloud.js';

// 防止重复执行
let _running = false;

// 生成坐标+年份索引键（5位小数 ≈ 1m 精度，足以唯一标识 InSAR 点）
function anomalyKey(pt) {
    return `${pt.longitude.toFixed(5)},${pt.latitude.toFixed(5)},${pt.year ?? ''}`;
}

// ============================================================
// 空间网格索引：将 O(n²) 邻域查询降至 O(n·k)，k≈平均邻域点数
//
// 原理：按 radius 大小将空间分格，每格只存本格点的索引。
// 查询时只检查 3×3 邻近格（cellSize=radius 时保证不漏掉任何半径内的点），
// 再对候选点精确算距离过滤。
// ============================================================
function _buildSpatialGrid(data, radius) {
    // 使用与距离计算相同的近似投影：度 → km
    const grid = new Map();
    for (let i = 0; i < data.length; i++) {
        const pt = data[i];
        const xKm = pt.longitude * 111.32;
        const yKm = pt.latitude  * 110.57;
        const cx = Math.floor(xKm / radius);
        const cy = Math.floor(yKm / radius);
        const key = `${cx},${cy}`;
        let cell = grid.get(key);
        if (!cell) { cell = []; grid.set(key, cell); }
        cell.push(i);
    }
    return grid;
}

function _getNeighborDefs(ptIdx, data, grid, radius) {
    const pt = data[ptIdx];
    const xKm = pt.longitude * 111.32;
    const yKm = pt.latitude  * 110.57;
    const cx = Math.floor(xKm / radius);
    const cy = Math.floor(yKm / radius);
    const r2 = radius * radius;

    const defs = [];
    // 只需检查 3×3 邻近格（cellSize=radius 时覆盖所有 ≤ radius 的点）
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const cell = grid.get(`${cx + dx},${cy + dy}`);
            if (!cell) continue;
            for (const j of cell) {
                if (j === ptIdx) continue;
                const q = data[j];
                const dLng = (pt.longitude - q.longitude) * 111.32;
                const dLat = (pt.latitude  - q.latitude)  * 110.57;
                if (dLng * dLng + dLat * dLat < r2) {   // 避免 sqrt，改用平方比较
                    defs.push(q.deformation);
                }
            }
        }
    }
    return defs;
}

// 异步分块执行：每 CHUNK 个点 yield 一次主线程，保证 UI 不冻结
async function _detectSpatialAsync(data, threshold, radius, onProgress) {
    const CHUNK = 500;
    const grid  = _buildSpatialGrid(data, radius);
    const result = [];

    for (let i = 0; i < data.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, data.length);
        for (let k = i; k < end; k++) {
            const neighborDefs = _getNeighborDefs(k, data, grid, radius);
            if (!neighborDefs.length) continue;

            // 一次遍历同时算均值和方差
            let sum = 0, sumSq = 0;
            for (const v of neighborDefs) { sum += v; sumSq += v * v; }
            const n = neighborDefs.length;
            const nMean = sum / n;
            const nStd  = Math.sqrt(Math.max(0, sumSq / n - nMean * nMean)) || 1;

            if (Math.abs(data[k].deformation - nMean) > threshold * nStd) {
                result.push(data[k]);
            }
        }
        if (onProgress) onProgress(end / data.length);
        // 让出主线程，避免浏览器卡死
        await new Promise(r => setTimeout(r, 0));
    }
    return result;
}

// -------- stddev / percentile 同步检测（自身不耗时） --------
function _detectFast(data, method, threshold) {
    if (!data || !data.length) return [];
    const defs = data.map(d => d.deformation);
    let sum = 0, sumSq = 0;
    for (const v of defs) { sum += v; sumSq += v * v; }
    const n    = defs.length;
    const mean = sum / n;
    const std  = Math.sqrt(Math.max(0, sumSq / n - mean * mean)) || 1;

    if (method === 'stddev') {
        return data.filter(d => Math.abs(d.deformation - mean) > threshold * std);
    }
    // percentile
    const sorted = [...defs].sort((a, b) => a - b);
    const lowP   = sorted[Math.floor(n * 0.05)];
    const highP  = sorted[Math.floor(n * 0.95)];
    return data.filter(d => d.deformation < lowP || d.deformation > highP);
}

// -------- 刷新当前时段的统计 UI（切换时间时调用）--------
export function updateAnomalyPeriodDisplay(year) {
    if (!STATE.anomalyIndex || !STATE.anomalyIndex.size) return;

    let allData = [];
    for (const ds of STATE.datasets) {
        if (ds.visible && ds.data) allData = allData.concat(ds.data);
    }
    const tf = year ?? STATE.timeFilter;
    const periodData = tf != null
        ? allData.filter(d => String(d.year) === String(tf))
        : allData;

    let cnt = 0;
    for (const pt of periodData) {
        if (STATE.anomalyIndex.has(anomalyKey(pt))) cnt++;
    }

    const elCount = document.getElementById('anomalyPeriodCount');
    const elRow   = document.getElementById('anomalyPeriodRow');
    if (elCount) elCount.textContent = cnt;
    if (elRow) {
        elRow.style.display = tf != null ? '' : 'none';
        const keyEl = elRow.querySelector('.key');
        if (keyEl && tf != null) keyEl.textContent = `当前时段 (${tf})`;
    }
}

// -------- 主入口 --------
export async function runAnomalyDetection() {
    if (_running) { toast('检测正在进行中，请稍候', 'info'); return; }
    if (!STATE.datasets.length || !STATE.datasets.some(d => d.visible && d.data && d.data.length)) {
        toast('请先加载数据到地图', 'warning');
        return;
    }

    const method    = document.getElementById('anomalyMethod').value;
    const threshold = parseFloat(document.getElementById('anomalyThreshold').value);
    const radius    = parseFloat(document.getElementById('neighborhoodRadius').value);

    let allData = [];
    for (const ds of STATE.datasets) {
        if (ds.visible && ds.data) allData = allData.concat(ds.data);
    }
    if (!allData.length) { toast('没有可分析的数据', 'warning'); return; }

    // 空间方法：给出数据量提示
    if (method === 'spatial') {
        const years  = STATE.timeData.length >= 2 ? STATE.timeData : [null];
        const perYear = Math.round(allData.length / years.length);
        toast(`空间检测中（${perYear.toLocaleString()} 点/时段），请稍候…`, 'info');
    }

    // 锁定按钮，防止重复点击
    _running = true;
    const btn = document.getElementById('runAnomalyBtn');
    const origHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 检测中 <span id="_anomalyPct"></span>'; }

    const setPct = (pct) => {
        const el = document.getElementById('_anomalyPct');
        if (el) el.textContent = `${Math.round(pct * 100)}%`;
    };

    STATE.anomalyIndex  = new Set();
    STATE.anomalyPoints = [];
    STATE._lastAnomalyMethod = { method, threshold, radius };

    let totalAnomalies = 0;
    const years = STATE.timeData.length >= 2 ? STATE.timeData : [null];

    try {
        for (let yi = 0; yi < years.length; yi++) {
            const year = years[yi];
            const subset = year !== null
                ? allData.filter(d => String(d.year) === String(year))
                : allData;
            if (!subset.length) continue;

            let anomalies;
            if (method === 'spatial') {
                // 异步分块：回调进度 = 当前年份进度比例叠加到总进度
                anomalies = await _detectSpatialAsync(subset, threshold, radius, (p) => {
                    const overall = (yi + p) / years.length;
                    setPct(overall);
                });
            } else {
                anomalies = _detectFast(subset, method, threshold);
            }

            totalAnomalies += anomalies.length;
            for (const pt of anomalies) {
                STATE.anomalyIndex.add(anomalyKey(pt));
            }
        }
    } finally {
        _running = false;
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
    }

    // 保留 anomalyPoints 存当前时段（兼容旧路径统计）
    const tf = STATE.timeFilter;
    STATE.anomalyPoints = allData.filter(d =>
        (tf == null || String(d.year) === String(tf)) &&
        STATE.anomalyIndex.has(anomalyKey(d))
    );

    updateVisualization();

    const methodLabel = {
        stddev:     `标准差阈值 (${threshold}σ)`,
        percentile: '百分位数 (5%/95%)',
        spatial:    `空间邻域差异 (r=${radius}km)`,
    }[method] || method;

    document.getElementById('anomalyResult').style.display = 'block';
    document.getElementById('anomalyMethodDisplay').textContent = methodLabel;
    document.getElementById('anomalyCount').textContent = totalAnomalies;
    document.getElementById('anomalyRatio').textContent =
        (totalAnomalies / allData.length * 100).toFixed(1) + '%';
    updateAnomalyPeriodDisplay(tf);

    const msg = years.length > 1
        ? `全时段共 ${totalAnomalies} 个异常点（${years.length} 个时段分别检测）`
        : `检测完成，共 ${totalAnomalies} 个异常点`;
    toast(msg, totalAnomalies ? 'warning' : 'success');
}

export function clearAnomalyMarkers() {
    STATE.anomalyPoints = [];
    STATE.anomalyIndex  = null;
    STATE._lastAnomalyMethod = null;
    document.getElementById('anomalyResult').style.display = 'none';
    updateVisualization();
    toast('已清除异常标记', 'info');
}
