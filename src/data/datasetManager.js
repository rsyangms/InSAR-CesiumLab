// =========================== 数据集管理 ===========================
import { STATE, toast, updateLoadedFilesUI, vectorMapCache } from '../core/state.js';
import { buildVoxelLOD, clearFile } from './loader.js';
import { updateVisualization } from '../render/pointCloud.js';

export async function addDataset(name, data, stats) {
    const tLodStart = performance.now();   // 测试: LOD 构建耗时计时起点
    const voxelLevels = buildVoxelLOD(data);
    console.log(`[LOD构建] ${data.length} 点 → ${(performance.now() - tLodStart).toFixed(0)} ms`);   // 测试
    const ds = { id: 'ds-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), name: name || '未命名', type: 'custom', visible: true, data, voxelLevels, stats: stats || { total: data.length, valid: data.length, invalid: 0 }, createdAt: new Date().toISOString() };
    STATE.datasets.push(ds);
    STATE.activeDatasetId = ds.id;
    STATE.isLoaded = true;
    detectTimeData();
    updateVisualization();
    updateDatasetList();
    if (STATE._boundaryFullCoordinates) {
        const { renderBoundary, computeRegionStats } = await import('../analysis/stats.js');
        renderBoundary();
        setTimeout(() => computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeFilter), 100);
    }
    refreshPointsPresence();
    return ds;
}

// ==================== 视图和图层控制 =====================
export function removeDataset(id) {
    STATE.datasets = STATE.datasets.filter(d => d.id !== id);
    if (STATE.activeDatasetId === id) STATE.activeDatasetId = STATE.datasets.length ? STATE.datasets[0].id : null;
    if (!STATE.datasets.length) STATE.isLoaded = false;
    detectTimeData();
    updateVisualization();
    updateDatasetList();
    refreshPointsPresence();
}

export function toggleDatasetVisibility(id) {
    const ds = STATE.datasets.find(d => d.id === id);
    if (ds) { ds.visible = !ds.visible; updateVisualization(); updateDatasetList(); refreshPointsPresence(); }
}

// ==================== 更新数据图层 =====================
export function updateDatasetList() {
    const suffixes = ['', 'Analysis', 'Roam'];
    for (const suf of suffixes) {
        const container = document.getElementById('datasetList' + suf);
        if (!container) continue;
        if (!STATE.datasets.length) {
            container.innerHTML = '<div class="empty-state">暂无数据集，请上传文件</div>';
            continue;
        }
        container.innerHTML = STATE.datasets.map(ds => `
            <div class="dataset-item">
                <div class="vis-toggle ${ds.visible ? 'visible' : ''}" data-id="${ds.id}"></div>
                <div class="info">
                    <div class="name">${ds.name}</div>
                    <div class="meta">${ds.stats?.valid || ds.data.length} 点 · ${new Date(ds.createdAt).toLocaleString()}</div>
                </div>
                <button class="del-btn" data-id="${ds.id}" title="删除">✕</button>
            </div>
        `).join('');
        container.querySelectorAll('.vis-toggle').forEach(el => {
            el.addEventListener('click', () => toggleDatasetVisibility(el.dataset.id));
        });
        container.querySelectorAll('.del-btn').forEach(el => {
            el.addEventListener('click', () => removeDataset(el.dataset.id));
        });
    }
}

// ==================== 清除数据集 =====================
export async function clearAllDatasets(module) {
    STATE.datasets = [];
    STATE.activeDatasetId = null;
    STATE.isLoaded = false;
    STATE.parsedData = null;
    STATE.currentFile = null;
    STATE.anomalyPoints = [];
    STATE.loadedFileNames = [];
    clearFile(module);
    updateVisualization();
    detectTimeData();
    updateLoadedFilesUI(module);
    for (const key of Object.keys(vectorMapCache)) {
        for (const f of vectorMapCache[key]) delete f._hasPoints;
    }
    refreshPointsPresence();
    updateDatasetList();
    const visControls = document.getElementById('visControls');
    if (visControls) visControls.style.display = 'none';
    toast('已清空全部数据', 'info');
}

// =========================== 时间序列 ===========================
export function detectTimeData() {
    const allYears = new Set();
    for (const ds of STATE.datasets) {
        if (!ds.data) continue;
        for (const d of ds.data) {
            if (d.year != null) allYears.add(String(d.year));
        }
    }
    const years = [...allYears].sort();
    const timeSlider = document.getElementById('timeSlider');
    const timeDisplay = document.getElementById('timeDisplay');
    if (years.length >= 2) {
        STATE.timeData = years;
        STATE.timeFilter = years[0];
        if (timeSlider) { timeSlider.max = years.length - 1; timeSlider.value = 0; }
        if (timeDisplay) timeDisplay.textContent = years[0];
        STATE.timeIndex = 0;
        toast(`🎬 检测到多年时间序列：共 ${years.length} 个时段，已启用播放`, 'success');
    } else if (years.length === 1) {
        STATE.timeData = [years[0]];
        STATE.timeFilter = years[0];
        if (timeSlider) { timeSlider.max = 0; timeSlider.value = 0; }
        if (timeDisplay) timeDisplay.textContent = years[0];
        STATE.timeIndex = 0;
    } else {
        STATE.timeData = [];
        STATE.timeFilter = null;
        if (timeDisplay) timeDisplay.textContent = '—';
    }
    updateVisualization();
}

export async function applyTimeFilter(year) {
    if (!year) return;
    STATE.timeFilter = year;
    updateVisualization();
    // 时间段切换时，同步刷新异常检测结果面板（若已有检测结果）
    if (STATE.anomalyIndex && STATE.anomalyIndex.size > 0) {
        const { updateAnomalyPeriodDisplay } = await import('../analysis/anomaly.js');
        updateAnomalyPeriodDisplay(year);
    }
    const activeBtn = document.querySelector('.vector-map-btn.active-map');
    const activeFile = activeBtn?.dataset.file;
    if (activeFile && vectorMapCache[activeFile]) {
        setTimeout(async () => {
            const { computeFeaturesPointPresence, renderFeatureList } = await import('../analysis/stats.js');
            computeFeaturesPointPresence(vectorMapCache[activeFile]);
            const searchVal = document.getElementById('featureSearchInput').value;
            renderFeatureList(vectorMapCache[activeFile], activeFile, searchVal);
        }, 50);
    }
}

// ==================== 刷新点存在性 =====================
async function refreshPointsPresence() {
    const activeBtn = document.querySelector('.vector-map-btn.active-map');
    const activeFile = activeBtn?.dataset.file;
    if (!activeFile || !vectorMapCache[activeFile]) return;
    const features = vectorMapCache[activeFile];
    setTimeout(async () => {
        const { computeFeaturesPointPresence, renderFeatureList } = await import('../analysis/stats.js');
        computeFeaturesPointPresence(features);
        const searchVal = document.getElementById('featureSearchInput').value;
        renderFeatureList(features, activeFile, searchVal);
    }, 50);
}