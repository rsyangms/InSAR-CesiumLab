// =========================== 事件监听 ===========================
import { STATE, toast, vectorMapCache, arrayMin, arrayMax } from '../core/state.js';
import { viewer, scene, switchBasemap, applyVerticalExaggeration, applyTerrainOpacity } from '../core/viewer.js';
import { handleFiles, loadDataToMap, clearFile } from '../data/loader.js';
import { updateDatasetList, clearAllDatasets, applyTimeFilter, detectTimeData } from '../data/datasetManager.js';
import { updateVisualization, updateLODDisplay, highlightPickedPoint } from '../render/pointCloud.js';
import { updateColorRampPreview } from '../render/colorMap.js';
import { runAnomalyDetection, clearAnomalyMarkers } from '../analysis/anomaly.js';
import { loadVectorMap, renderAllBoundaries, renderFeatureList, clearAllBoundaries, loadBoundaryFromFeature, handleBoundaryFile, clearBoundary, computeRegionStats, computeFeaturesPointPresence } from '../analysis/stats.js';

// =========================== 工具栏状态 ===========================
const TB = {
    measureMode: null,        // 'distance' | 'area' | null
    measurePoints: [],        // 测量采集的点
    measureEntities: [],      // Cesium 测量实体
    annotateActive: false,    // 标注放置模式
    annotateColor: '#4A9EFF', // 当前标注颜色
    annotations: [],          // { text, color, lng, lat, entity }
};

export function initEvents() {
    // =============== 速率范围 / 色标条 ===============
function updateColorBarLabels(min, max) {
    const minLbl = document.getElementById('colorBarMinLabel');
    const maxLbl = document.getElementById('colorBarMaxLabel');
    if (minLbl) minLbl.textContent = (min ?? '-').toFixed?.(2) ?? min;
    if (maxLbl) maxLbl.textContent = (max ?? '-').toFixed?.(2) ?? max;
}

document.getElementById('applyColorRange')?.addEventListener('click', async () => {
    const minEl = document.getElementById('colorMinInput');
    const maxEl = document.getElementById('colorMaxInput');
    const mn = parseFloat(minEl.value);
    const mx = parseFloat(maxEl.value);
    if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn >= mx) {
        toast('范围无效: 最小值必须小于最大值', 'warning');
        return;
    }
    STATE.colorMin = mn;
    STATE.colorMax = mx;
    updateColorBarLabels(mn, mx);
    const m = await import('../render/pointCloud.js');
    m.updateVisualization();
    toast(`已应用范围 ${mn} ~ ${mx} mm/yr`, 'success');
});

document.getElementById('resetColorRange')?.addEventListener('click', async () => {
    STATE.colorMin = null;
    STATE.colorMax = null;
    const m = await import('../render/pointCloud.js');
    m.updateVisualization();
    // 重绘后从 STATE._colorMin/_Max 取实际值回填到输入框
    setTimeout(() => {
        const minEl = document.getElementById('colorMinInput');
        const maxEl = document.getElementById('colorMaxInput');
        if (minEl && Number.isFinite(STATE._colorMin)) minEl.value = STATE._colorMin.toFixed(2);
        if (maxEl && Number.isFinite(STATE._colorMax)) maxEl.value = STATE._colorMax.toFixed(2);
        updateColorBarLabels(STATE._colorMin, STATE._colorMax);
    }, 100);
    toast('已切回自适应范围', 'info');
});

// 初始化:加载数据后自动同步色标条标签
window.addEventListener('load', () => {
    setTimeout(() => updateColorBarLabels(
        STATE.colorMin ?? STATE._colorMin ?? -10,
        STATE.colorMax ?? STATE._colorMax ?? 10
    ), 500);
});


    document.querySelectorAll('.bm-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchBasemap(btn.dataset.bm);
        });
    });

    // —— 缩放 ——
    document.getElementById('tbZoomIn')?.addEventListener('click', () => {
        if (!viewer) return;
        const cart = viewer.camera.positionCartographic;
        const newH = Math.max(200, cart.height * 0.5);
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(cart.longitude, cart.latitude, newH),
            duration: 0.6,
        });
    });
    document.getElementById('tbZoomOut')?.addEventListener('click', () => {
        if (!viewer) return;
        const cart = viewer.camera.positionCartographic;
        const newH = Math.min(20000000, cart.height * 2);
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(cart.longitude, cart.latitude, newH),
            duration: 0.6,
        });
    });

    // —— 测量下拉 ——
    const measureBtn = document.getElementById('tbMeasureBtn');
    const measureDd  = document.getElementById('measureDropdown');
    measureBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        measureDd.classList.toggle('open');
    });
    document.querySelectorAll('.mdd-item').forEach(item => {
        item.addEventListener('click', () => {
            const mode = item.dataset.measure;
            measureDd.classList.remove('open');
            document.querySelectorAll('.mdd-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            _startMeasure(mode);
        });
    });
    document.addEventListener('click', (e) => {
        if (!measureDd.contains(e.target) && e.target !== measureBtn) {
            measureDd.classList.remove('open');
        }
    });

    // —— 取消测量 ——
    document.getElementById('measureCancelBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _stopMeasure();
    });
    // Escape 键取消测量
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && TB.measureMode) _stopMeasure();
    });

    // —— 标注 ——
    const annotateBtn = document.getElementById('tbAnnotateBtn');
    const annotatePanel = document.getElementById('annotationPanel');
    annotateBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = annotatePanel.classList.toggle('open');
        annotateBtn.classList.toggle('active', isOpen);
        if (!isOpen) _cancelAnnotate();
    });
    // 标注颜色选择
    document.querySelectorAll('.ann-color').forEach(dot => {
        dot.addEventListener('click', () => {
            document.querySelectorAll('.ann-color').forEach(d => d.classList.remove('sel'));
            dot.classList.add('sel');
            TB.annotateColor = dot.dataset.color;
        });
    });
    // 确认进入放置模式
    document.getElementById('annConfirmBtn')?.addEventListener('click', () => {
        const text = document.getElementById('annTextInput').value.trim();
        if (!text) { toast('请输入标注文字', 'warning'); return; }
        TB.annotateActive = true;
        annotateBtn.classList.add('active');
        viewer.scene.canvas.style.cursor = 'crosshair';
        toast('点击地图放置标注', 'info');
    });
    document.getElementById('annCancelBtn')?.addEventListener('click', () => {
        annotatePanel.classList.remove('open');
        annotateBtn.classList.remove('active');
        _cancelAnnotate();
    });

    // —— 截图 ——
    document.getElementById('tbScreenshotBtn')?.addEventListener('click', () => {
        if (!viewer) return;
        viewer.render();
        const canvas = viewer.scene.canvas;
        try {
            const dataURL = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = dataURL;
            a.download = `InSAR_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.png`;
            a.click();
            toast('截图已保存', 'success');
        } catch (err) {
            toast('截图失败（跨域限制），请尝试使用本地服务器', 'error');
        }
    });

    // —— 昼夜主题切换 ——
    (function () {
        const btn       = document.getElementById('tbThemeBtn');
        const iconNight = document.getElementById('tbThemeIconNight');
        const iconDay   = document.getElementById('tbThemeIconDay');
        const label     = btn?.lastChild;          // 文本节点
        if (!btn) return;

        let isDay = false;

        btn.addEventListener('click', () => {
            isDay = !isDay;
            if (isDay) {
                document.body.classList.add('day-theme');
                iconNight.style.display = 'none';
                iconDay.style.display   = 'block';
                btn.lastChild.textContent = '白天';
                btn.title = '切换至暗夜模式';
            } else {
                document.body.classList.remove('day-theme');
                iconNight.style.display = 'block';
                iconDay.style.display   = 'none';
                btn.lastChild.textContent = '暗夜';
                btn.title = '切换至白天模式';
            }
        });
    })();

    // —— 重置视图（缩放到数据范围，正射俯视）——
    document.getElementById('tbResetViewBtn')?.addEventListener('click', () => {
        if (!viewer) return;
        const vds = STATE.datasets.filter(d => d.visible && d.data && d.data.length);
        if (!vds.length) { toast('请先加载数据', 'warning'); return; }

        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const ds of vds) {
            for (const d of ds.data) {
                if (d.longitude < minLng) minLng = d.longitude;
                if (d.longitude > maxLng) maxLng = d.longitude;
                if (d.latitude  < minLat) minLat = d.latitude;
                if (d.latitude  > maxLat) maxLat = d.latitude;
            }
        }
        if (!isFinite(minLng)) return;

        const lngPad = Math.max((maxLng - minLng) * 0.12, 0.004);
        const latPad = Math.max((maxLat - minLat) * 0.12, 0.004);
        try {
            viewer.camera.flyTo({
                destination: Cesium.Rectangle.fromDegrees(
                    minLng - lngPad, minLat - latPad,
                    maxLng + lngPad, maxLat + latPad
                ),
                orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
                duration: 1.5,
            });
        } catch (_) {
            // 降级：中心点 + 估算高度
            const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
            const spanDeg = Math.max(maxLng - minLng, (maxLat - minLat) * 1.4);
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(cLng, cLat, spanDeg * 111320 * 1.4),
                orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
                duration: 1.5,
            });
        }
    });

    // —— 地形夸张 ——
    const exagInput = document.getElementById('tbExagInput');
    function _applyTerrainExaggeration(raw) {
        const val = parseFloat(raw);
        if (!isFinite(val) || val < 1 || val > 1000) {
            exagInput?.classList.add('invalid');
            return;
        }
        exagInput?.classList.remove('invalid');
        STATE.terrainExaggeration = val;
        // 同步左侧面板滑块（如存在）
        const slider = document.getElementById('terrainExagSlider');
        const sliderVal = document.getElementById('terrainExagValue');
        if (slider) { slider.value = Math.min(val, parseFloat(slider.max)); }
        if (sliderVal) sliderVal.textContent = val + '×';
        applyVerticalExaggeration(val);// 联动统一，STATE
        updateVisualization();
    }
    exagInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { _applyTerrainExaggeration(exagInput.value); exagInput.blur(); }
    });
    exagInput?.addEventListener('blur', () => {
        _applyTerrainExaggeration(exagInput.value);
    });
    exagInput?.addEventListener('input', () => {
        exagInput.classList.remove('invalid');
    });
    // 初始应用默认值
    setTimeout(() => _applyTerrainExaggeration(STATE.terrainExaggeration), 900);

    // —— 搜索框 ——
    const searchInput = document.getElementById('tbSearchInput');
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const q = searchInput.value.trim();
        if (!q) return;
        // 先尝试解析 "经度,纬度" 格式
        const coordMatch = q.match(/^(-?\d+\.?\d*)[,\s，]+(-?\d+\.?\d*)$/);
        if (coordMatch) {
            const lng = parseFloat(coordMatch[1]);
            const lat = parseFloat(coordMatch[2]);
            if (isFinite(lng) && isFinite(lat)) {
                viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(lng, lat, 50000),
                    duration: 1.2,
                });
                toast(`已定位至 ${lng.toFixed(4)}, ${lat.toFixed(4)}`, 'success');
                searchInput.value = '';
                return;
            }
        }
        // 调用 Nominatim 地名搜索（OpenStreetMap）
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=zh`;
        fetch(url, { headers: { 'Accept-Language': 'zh-CN,zh' } })
            .then(r => r.json())
            .then(results => {
                if (!results || !results.length) { toast(`未找到地名：${q}`, 'warning'); return; }
                const res = results[0];
                const lng = parseFloat(res.lon), lat = parseFloat(res.lat);
                viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(lng, lat, 100000),
                    duration: 1.5,
                });
                toast(`已定位至：${res.display_name.slice(0, 30)}`, 'success');
                searchInput.value = '';
            })
            .catch(() => toast('搜索失败，请检查网络连接', 'error'));
    });

// 全密度模式开关
document.getElementById('fullDensityToggle')?.addEventListener('change', async (e) => {
    STATE.fullDensityMode = e.target.checked;
    const hint = document.getElementById('fullDensityHint');
    if (hint) hint.style.display = e.target.checked ? 'block' : 'none';
    
    if (e.target.checked) {
        toast('已开启全密度模式 (首屏构建稍慢,请稍候)', 'info');
    } else {
        toast('已切回自适应 LOD 模式', 'info');
    }
    
    // 触发重绘
    const m = await import('../render/pointCloud.js');
    m.updateVisualization();
});

	// 3D Tiles 模式开关
	document.getElementById('toggleTilesMode')?.addEventListener('click', async function() {
	    this.classList.toggle('active');
	    const isTiles = this.classList.contains('active');

	    const m = await import('../render/pointCloud.js');
	    m.ensureCollections();

	    STATE.renderMode = isTiles ? 'tiles' : 'primitive';
	    if (isTiles) {
	        // 3D Tiles 需要地形高程：强制勾选所有地形采样复选框
	        ['', 'Analysis', 'Roam'].forEach(suffix => {
	            const cb = document.getElementById('enableTerrainSampling' + suffix);
	            if (cb) cb.checked = true;
	        });
	        // 检查已加载数据是否缺少高程
	        const hasNoHeight = STATE.datasets.some(ds =>
	            ds.data && ds.data.length > 0 &&
	            ds.data.every(d => !Number.isFinite(Number(d.groundHeight))));
	        if (hasNoHeight) {
	            toast('已强制开启地形采样。现有数据缺少高程，建议重新加载', 'warning');
	        }
	        toast('已切换至 3D Tiles 模式 (GPU批量渲染)', 'info');
	    } else {
	        toast('已切回 Primitive 模式', 'info');
	    }
	    m.updateVisualization();
	});

    // ===================== 底部状态栏 — 鼠标坐标实时更新 =====================
    if (viewer) {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((movement) => {
            _updateStatusCoord(movement.endPosition);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    }

    // 相机变化时更新缩放值和比例尺
    if (viewer?.camera?.changed) {
        viewer.camera.changed.addEventListener(() => {
            _updateZoomLabel();
            _updateScaleBar();
        });
    }
    // 初次更新
    setTimeout(() => { _updateZoomLabel(); _updateScaleBar(); _updateColorRampBar(); }, 800);

    // ===================== 文件上传事件 =====================
    const dropZone = document.getElementById('fileDropZone'), fileInput = document.getElementById('fileInput');
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files, ''); });
        fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFiles(fileInput.files, ''); });
    }
    document.getElementById('loadDataBtn')?.addEventListener('click', () => loadDataToMap(''));
    document.getElementById('batchLoadBtn')?.addEventListener('click', () => {
        if (STATE.parsedData && STATE.parsedData.length) { loadDataToMap(''); } else { toast('请先上传数据文件', 'warning'); }
    });
    document.getElementById('clearAllBtn')?.addEventListener('click', () => {
        if (STATE.datasets.length && confirm('确定清空所有数据？')) clearAllDatasets('');
    });

    // 交互分析模块
    const dropZoneAnalysis = document.getElementById('fileDropZoneAnalysis'), fileInputAnalysis = document.getElementById('fileInputAnalysis');
    if (dropZoneAnalysis && fileInputAnalysis) {
        dropZoneAnalysis.addEventListener('click', () => fileInputAnalysis.click());
        dropZoneAnalysis.addEventListener('dragover', e => { e.preventDefault(); dropZoneAnalysis.classList.add('dragover'); });
        dropZoneAnalysis.addEventListener('dragleave', () => dropZoneAnalysis.classList.remove('dragover'));
        dropZoneAnalysis.addEventListener('drop', e => { e.preventDefault(); dropZoneAnalysis.classList.remove('dragover'); handleFiles(e.dataTransfer.files, 'analysis'); });
        fileInputAnalysis.addEventListener('change', () => { if (fileInputAnalysis.files.length) handleFiles(fileInputAnalysis.files, 'analysis'); });
    }
    document.getElementById('loadDataBtnAnalysis')?.addEventListener('click', () => loadDataToMap('analysis'));
    document.getElementById('batchLoadBtnAnalysis')?.addEventListener('click', () => {
        if (STATE.parsedData && STATE.parsedData.length) { loadDataToMap('analysis'); } else { toast('请先上传数据文件', 'warning'); }
    });
    document.getElementById('clearAllBtnAnalysis')?.addEventListener('click', () => {
        if (STATE.datasets.length && confirm('确定清空所有数据？')) clearAllDatasets('analysis');
    });

    // 漫游模块
    const dropZoneRoam = document.getElementById('fileDropZoneRoam'), fileInputRoam = document.getElementById('fileInputRoam');
    if (dropZoneRoam && fileInputRoam) {
        dropZoneRoam.addEventListener('click', () => fileInputRoam.click());
        dropZoneRoam.addEventListener('dragover', e => { e.preventDefault(); dropZoneRoam.classList.add('dragover'); });
        dropZoneRoam.addEventListener('dragleave', () => dropZoneRoam.classList.remove('dragover'));
        dropZoneRoam.addEventListener('drop', e => { e.preventDefault(); dropZoneRoam.classList.remove('dragover'); handleFiles(e.dataTransfer.files, 'roam'); });
        fileInputRoam.addEventListener('change', () => { if (fileInputRoam.files.length) handleFiles(fileInputRoam.files, 'roam'); });
    }
    document.getElementById('loadDataBtnRoam')?.addEventListener('click', () => loadDataToMap('roam'));
    document.getElementById('batchLoadBtnRoam')?.addEventListener('click', () => {
        if (STATE.parsedData && STATE.parsedData.length) { loadDataToMap('roam'); } else { toast('请先上传数据文件', 'warning'); }
    });
    document.getElementById('clearAllBtnRoam')?.addEventListener('click', () => {
        if (STATE.datasets.length && confirm('确定清空所有数据？')) clearAllDatasets('roam');
    });

    // =========================== 视觉控制 ===========================
    document.getElementById('togglePointCloud')?.addEventListener('click', function() {
        this.classList.toggle('active');
        STATE.pointCloudVisible = this.classList.contains('active');
        updateVisualization();
    });
    document.getElementById('heightOffset')?.addEventListener('input', function() {
        STATE.heightOffset = parseFloat(this.value);
        document.getElementById('heightOffsetVal').textContent = this.value + ' m';
        updateVisualization();
    });

    const terrainOpacitySlider = document.getElementById('terrainOpacitySlider');
    const terrainOpacityValue = document.getElementById('terrainOpacityValue');
    if (terrainOpacitySlider) {
        terrainOpacitySlider.value = String(Math.round((STATE.terrainOpacity ?? 0.65) * 100));
        if (terrainOpacityValue) terrainOpacityValue.textContent = terrainOpacitySlider.value + '%';
        applyTerrainOpacity(Number(terrainOpacitySlider.value) / 100);
        terrainOpacitySlider.addEventListener('input', function() {
            STATE.terrainOpacity = Number(this.value) / 100;
            if (terrainOpacityValue) terrainOpacityValue.textContent = this.value + '%';
            applyTerrainOpacity(STATE.terrainOpacity);
        });
    }

    document.getElementById('pointSize')?.addEventListener('input', function() {
        STATE.pointSize = parseFloat(this.value);
        document.getElementById('pointSizeVal').textContent = this.value + ' px';
        updateVisualization();
    });
    document.getElementById('exaggerationSlider')?.addEventListener('input', function() {
        STATE.exaggeration = parseFloat(this.value);
        document.getElementById('exaggerationValue').textContent = this.value + '×';
        updateVisualization();
    });

    document.getElementById('terrainExagSlider')?.addEventListener('input', function() {
        STATE.terrainExaggeration = parseFloat(this.value);
        document.getElementById('terrainExagValue').textContent = this.value + '×';
        // 同步顶栏输入框
        const tbInput = document.getElementById('tbExagInput');
        if (tbInput) { tbInput.value = this.value; tbInput.classList.remove('invalid'); }
        // ✅ 使用统一 API
        applyVerticalExaggeration(STATE.terrainExaggeration);
        updateVisualization();
    });

    // 色带选择
    document.querySelectorAll('.color-ramp-opt').forEach(opt => {
        opt.addEventListener('click', function() {
            document.querySelectorAll('.color-ramp-opt').forEach(o => o.classList.remove('active'));
            this.classList.add('active');
            STATE.colorScheme = this.dataset.scheme;
            updateVisualization();
            updateColorRampPreview();
        });
    });

    // =========================== 时间序列 ===========================
    document.getElementById('timeSlider')?.addEventListener('input', function() {
        STATE.timeIndex = parseInt(this.value);
        if (STATE.timeData.length) {
            document.getElementById('timeDisplay').textContent = STATE.timeData[STATE.timeIndex];
            applyTimeFilter(STATE.timeData[STATE.timeIndex]);
            if (STATE._boundaryFullCoordinates) {
                computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeData[STATE.timeIndex]);
            }
        }
    });

    document.getElementById('timePrevBtn')?.addEventListener('click', () => {
        if (STATE.timeData.length) {
            STATE.timeIndex = Math.max(0, STATE.timeIndex - 1);
            document.getElementById('timeSlider').value = STATE.timeIndex;
            document.getElementById('timeDisplay').textContent = STATE.timeData[STATE.timeIndex];
            applyTimeFilter(STATE.timeData[STATE.timeIndex]);
            if (STATE._boundaryFullCoordinates) {
                computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeData[STATE.timeIndex]);
            }
        }
    });

    document.getElementById('timeNextBtn')?.addEventListener('click', () => {
        if (STATE.timeData.length) {
            STATE.timeIndex = Math.min(STATE.timeData.length - 1, STATE.timeIndex + 1);
            document.getElementById('timeSlider').value = STATE.timeIndex;
            document.getElementById('timeDisplay').textContent = STATE.timeData[STATE.timeIndex];
            applyTimeFilter(STATE.timeData[STATE.timeIndex]);
            if (STATE._boundaryFullCoordinates) {
                computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeData[STATE.timeIndex]);
            }
        }
    });

    document.getElementById('timePlayBtn')?.addEventListener('click', function() {
        if (!STATE.timeData.length || STATE.timeData.length < 2) {
            toast('请上传多年时间序列数据后再播放', 'warning');
            return;
        }
        if (STATE.timePlaying) {
            STATE.timePlaying = false;
            clearInterval(STATE.timePlayInterval);
            this.textContent = '▶';
            this.classList.remove('active');
            toast('⏸ 已暂停播放', 'info');
        } else {
            STATE.timePlaying = true;
            this.textContent = '⏸';
            this.classList.add('active');
            const speed = parseFloat(document.getElementById('playSpeed').value);
            STATE.timePlayInterval = setInterval(() => {
                STATE.timeIndex = (STATE.timeIndex + 1) % STATE.timeData.length;
                document.getElementById('timeSlider').value = STATE.timeIndex;
                document.getElementById('timeDisplay').textContent = STATE.timeData[STATE.timeIndex];
                applyTimeFilter(STATE.timeData[STATE.timeIndex]);
                if (STATE._boundaryFullCoordinates) {
                    computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeData[STATE.timeIndex]);
                }
            }, 1000 / speed);
            toast('▶ 开始播放时间序列', 'success');
        }
    });

    document.getElementById('playSpeed')?.addEventListener('input', function() {
        document.getElementById('playSpeedVal').textContent = this.value + 'x';
        if (STATE.timePlaying) {
            clearInterval(STATE.timePlayInterval);
            const speed = parseFloat(this.value);
            STATE.timePlayInterval = setInterval(() => {
                STATE.timeIndex = (STATE.timeIndex + 1) % STATE.timeData.length;
                document.getElementById('timeSlider').value = STATE.timeIndex;
                document.getElementById('timeDisplay').textContent = STATE.timeData[STATE.timeIndex];
                applyTimeFilter(STATE.timeData[STATE.timeIndex]);
                if (STATE._boundaryFullCoordinates) {
                    computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeData[STATE.timeIndex]);
                }
            }, 1000 / speed);
        }
    });

    // =========================== 点选查询 ===========================
    document.getElementById('togglePickMode')?.addEventListener('click', function() {
        this.classList.toggle('active');
        STATE.pickMode = this.classList.contains('active');
        if (STATE.pickMode) {
            document.getElementById('pickedPointInfo').style.display = 'none';
            toast('点选模式已开启，点击点云查询形变信息', 'info');
        } else {
            highlightPickedPoint(null);
            document.getElementById('pickedPointInfo').style.display = 'none';
            document.getElementById('lineChartContainer').classList.remove('visible');
        }
    });

    document.getElementById('lineChartCloseBtn')?.addEventListener('click', function() {
        document.getElementById('lineChartContainer').classList.remove('visible');
    });

    // =========================== 异常变形检测 ===========================
    document.getElementById('anomalyMethod')?.addEventListener('change', function() {
        if (this.value === 'spatial') {
            document.getElementById('anomalyThresholdGroup').style.display = 'none';
            document.getElementById('neighborhoodGroup').style.display = 'block';
        } else {
            document.getElementById('anomalyThresholdGroup').style.display = 'block';
            document.getElementById('neighborhoodGroup').style.display = 'none';
        }
    });

    document.getElementById('anomalyThreshold')?.addEventListener('input', function() {
        document.getElementById('anomalyThresholdVal').textContent = this.value + ' σ';
    });

    document.getElementById('neighborhoodRadius')?.addEventListener('input', function() {
        document.getElementById('neighborhoodRadiusVal').textContent = this.value + ' km';
    });

    document.getElementById('runAnomalyBtn')?.addEventListener('click', runAnomalyDetection);
    document.getElementById('clearAnomalyBtn')?.addEventListener('click', clearAnomalyMarkers);

    // =========================== 矢量底图 ===========================
    document.querySelectorAll('.vector-map-btn').forEach(btn => {
        btn.addEventListener('click', () => loadVectorMap(btn));
    });

    const boundaryDropZone = document.getElementById('boundaryDropZone');
    const boundaryFileInput = document.getElementById('boundaryFileInput');
    if (boundaryDropZone && boundaryFileInput) {
        boundaryDropZone.addEventListener('click', () => boundaryFileInput.click());
        boundaryDropZone.addEventListener('dragover', e => { e.preventDefault(); boundaryDropZone.classList.add('dragover'); });
        boundaryDropZone.addEventListener('dragleave', () => boundaryDropZone.classList.remove('dragover'));
        boundaryDropZone.addEventListener('drop', e => { e.preventDefault(); boundaryDropZone.classList.remove('dragover'); if (e.dataTransfer.files.length) handleBoundaryFile(e.dataTransfer.files[0]); });
        boundaryFileInput.addEventListener('change', () => { if (boundaryFileInput.files.length) handleBoundaryFile(boundaryFileInput.files[0]); });
    }

    document.getElementById('showAllBoundariesBtn')?.addEventListener('click', function() {
        const file = document.querySelector('.vector-map-btn.active-map')?.dataset.file;
        const features = file ? vectorMapCache[file] : null;
        if (!features) { toast('请先加载矢量底图', 'warning'); return; }
        if (STATE._allBoundariesIds.length > 0) { clearAllBoundaries(); toast('已隐藏全部边界', 'info'); }
        else { renderAllBoundaries(features); }
    });

    document.getElementById('featureSearchInput')?.addEventListener('input', function() {
        const file = document.querySelector('.vector-map-btn.active-map')?.dataset.file;
        if (file && vectorMapCache[file]) renderFeatureList(vectorMapCache[file], file, this.value);
    });

    document.getElementById('clearBoundaryBtn')?.addEventListener('click', clearBoundary);
    document.getElementById('recalcRegionBtn')?.addEventListener('click', () => {
        if (!STATE._boundaryFullCoordinates) { toast('请先加载边界', 'warning'); return; }
        computeRegionStats(STATE._boundaryFullCoordinates, STATE.timeFilter);
        toast('✅ 区域统计已刷新', 'success');
    });

    // =========================== 漫游模式 ===========================
    document.querySelectorAll('.roam-card').forEach(card => {
        card.addEventListener('click', function() {
            document.querySelectorAll('.roam-card').forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            if (ROAM.active) stopRoaming();
            document.getElementById('waypointControls').style.display = this.dataset.mode === 'custom' ? 'block' : 'none';
        });
    });

    document.getElementById('roamSpeed')?.addEventListener('input', function() {
        ROAM.speed = parseFloat(this.value);
        document.getElementById('roamSpeedVal').textContent = this.value + 'x';
    });

    document.getElementById('roamStartBtn')?.addEventListener('click', function() {
        const activeCard = document.querySelector('.roam-card.active');
        if (!activeCard) { toast('请先选择漫游模式', 'warning'); return; }
        startRoaming(activeCard.dataset.mode);
    });

    document.getElementById('roamStopBtn')?.addEventListener('click', stopRoaming);
    document.getElementById('addWaypointBtn')?.addEventListener('click', toggleWaypointMode);
    document.getElementById('clearWaypointsBtn')?.addEventListener('click', function() {
        if (ROAM.waypoints.length === 0) return;
        if (confirm('确定清空所有航点？')) { if (ROAM.waypointMode) toggleWaypointMode(); clearWaypoints(); }
    });
}

// =========================== 漫游模式 ===========================
const ROAM = { active: false, mode: null, listener: null, speed: 0.8, waypoints: [], waypointMode: false, waypointIndex: 0, waypointEntities: [] };

function stopRoaming() {
    if (ROAM.listener) { viewer.scene.postUpdate.removeEventListener(ROAM.listener); ROAM.listener = null; }
    if (ROAM.active && viewer.camera.cancelFlight) { viewer.camera.cancelFlight(); }
    // 释放 lookAt 锁定（低空环绕用 lookAt 会锁定相机，停止后需解锁）
    try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch (_) {}
    ROAM.active = false;
    ROAM.mode = null;
    const st = document.getElementById('roamStatus');
    st.classList.remove('active');
    st.querySelector('span:last-child').textContent = '已停止';
    document.getElementById('roamStartBtn').style.display = 'flex';
    document.getElementById('roamStopBtn').style.display = 'none';
    document.querySelectorAll('.roam-card').forEach(c => c.classList.remove('active'));
}

function addWaypoint(lng, lat, height) {
    ROAM.waypoints.push({ lng, lat, height: height || 0 });
    updateWaypointVisuals();
    updateWaypointListUI();
    toast(`航点 ${ROAM.waypoints.length} 已添加`, 'success');
}

function removeWaypoint(index) {
    if (index < 0 || index >= ROAM.waypoints.length) return;
    ROAM.waypoints.splice(index, 1);
    updateWaypointVisuals();
    updateWaypointListUI();
}

function clearWaypoints() {
    ROAM.waypoints = [];
    updateWaypointVisuals();
    updateWaypointListUI();
    toast('已清空所有航点', 'info');
}

function updateWaypointVisuals() {
    ROAM.waypointEntities.forEach(e => viewer.entities.remove(e));
    ROAM.waypointEntities = [];
    if (ROAM.waypoints.length === 0) return;
    const positions = ROAM.waypoints.map(wp => Cesium.Cartesian3.fromDegrees(wp.lng, wp.lat, (wp.height || 0) + 50));
    const polyline = viewer.entities.add({ polyline: { positions: positions, width: 2, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: Cesium.Color.CYAN.withAlpha(0.8) }), clampToGround: true } });
    ROAM.waypointEntities.push(polyline);
    ROAM.waypoints.forEach((wp, i) => {
        const marker = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(wp.lng, wp.lat, (wp.height || 0) + 100),
            point: { pixelSize: 12, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
            label: { text: String(i + 1), font: '12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -8) }
        });
        ROAM.waypointEntities.push(marker);
    });
}

function updateWaypointListUI() {
    const container = document.getElementById('waypointList');
    const countEl = document.getElementById('waypointCount');
    if (ROAM.waypoints.length === 0) { container.innerHTML = '<div class="empty-state">暂无航点</div>'; countEl.textContent = '共 0 个航点'; return; }
    container.innerHTML = ROAM.waypoints.map((wp, i) =>
        `<div class="waypoint-item"><span class="idx">#${i + 1}</span><span class="coords">${wp.lng.toFixed(4)}, ${wp.lat.toFixed(4)}</span><span class="remove-wp" data-index="${i}">✕</span></div>`
    ).join('');
    container.querySelectorAll('.remove-wp').forEach(el => { el.addEventListener('click', function() { removeWaypoint(parseInt(this.dataset.index)); }); });
    countEl.textContent = `共 ${ROAM.waypoints.length} 个航点`;
}

function toggleWaypointMode() {
    ROAM.waypointMode = !ROAM.waypointMode;
    const btn = document.getElementById('addWaypointBtn');
    const hint = document.getElementById('waypointHint');
    if (ROAM.waypointMode) {
        btn.innerHTML = '🔴 关闭添加';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-danger');
        hint.classList.add('active');
        viewer.scene.canvas.style.cursor = 'crosshair';
        toast('点击地图任意位置添加航点', 'info');
    } else {
        btn.innerHTML = '📌 添加航点';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        hint.classList.remove('active');
        viewer.scene.canvas.style.cursor = '';
    }
}

// ======================== 获取数据范围 ==========================
function getDataExtent() {
    const vds = STATE.datasets.filter(d => d.visible && d.data && d.data.length);
    if (!vds.length) return null;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    let maxTerrainHeight = 0;   // 数据点最大椭球高（用于保证相机在地形之上）
    for (const ds of vds) {
        for (const d of ds.data) {
            if (d.longitude < minLng) minLng = d.longitude;
            if (d.longitude > maxLng) maxLng = d.longitude;
            if (d.latitude  < minLat) minLat = d.latitude;
            if (d.latitude  > maxLat) maxLat = d.latitude;
            // height 字段即 WGS84 椭球高（CSV 中的 height 列）
            const h = Number(d.height ?? d.altitude ?? 0);
            if (isFinite(h) && h > maxTerrainHeight) maxTerrainHeight = h;
        }
    }
    const lngSpan = maxLng - minLng || 0.01, latSpan = maxLat - minLat || 0.01;
    return {
        minLng, maxLng, minLat, maxLat,
        centerLng: (minLng + maxLng) / 2,
        centerLat:  (minLat + maxLat) / 2,
        lngSpan, latSpan,
        maxTerrainHeight,   // 新增：数据区域最高地形（椭球高，米）
    };
}

// ======================== 获取高度视图 ==========================
function startHighAltitudeOverview(ext) {
    const alt = Math.max(8000, Math.max(ext.lngSpan, ext.latSpan) * 30000);
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(ext.centerLng, ext.centerLat, alt), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-85), roll: 0 }, duration: 3 });
    let h = 0;
    ROAM.listener = function(scene, time) {
        const cart = viewer.camera.positionCartographic;
        if (!cart || cart.height < alt * 0.85) return;
        const dt = Math.min(time.secondsPerTick || 0.016, 0.1);
        h = (h + ROAM.speed * 0.12 * dt) % (Math.PI * 2);
        viewer.camera.setView({ orientation: { heading: h, pitch: Cesium.Math.toRadians(-75), roll: 0 } });
    };
    viewer.scene.postUpdate.addEventListener(ROAM.listener);
}

// =============================== 低空漫游 =================================
function startLowAltitudeOrbit(ext) {
    const center = Cesium.Cartesian3.fromDegrees(ext.centerLng, ext.centerLat);
    const dataSpan = Math.max(ext.lngSpan, ext.latSpan);
    // 环绕半径与俯角保持一致，让相机真正处于"低空"
    // pitch=-25°时: 相机高度 = radius * sin(25°) ≈ radius * 0.423
    const pitchRad = Cesium.Math.toRadians(-25);
    const radius   = Math.max(600, Math.min(20000, dataSpan * 30000));
    const orbitH   = Math.max(300, radius * Math.sin(Math.abs(pitchRad)));

    let h = 0;
    let orbitStarted = false;
    let lastMs = null;

    // 飞入到数据上方后再启动环绕，避免高度guard与实际轨道高度不一致导致卡死
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(ext.centerLng, ext.centerLat, orbitH * 1.2),
        duration: 2.0,
        complete: () => {
            if (ROAM.active && ROAM.mode === 'low-orbit') orbitStarted = true;
        },
    });

    ROAM.listener = function(scene, _time) {
        if (!orbitStarted) return;
        const nowMs = performance.now();
        const dt = lastMs ? Math.min((nowMs - lastMs) / 1000, 0.1) : 0.016;
        lastMs = nowMs;
        h = (h + ROAM.speed * 0.5 * dt) % (Math.PI * 2);
        viewer.camera.lookAt(center, new Cesium.HeadingPitchRange(h, pitchRad, radius));
    };
    viewer.scene.postUpdate.addEventListener(ROAM.listener);
}

// ================================== 区域巡视（正射） ===============================
function startAreaPatrol(ext) {
    // ── 1. 几何参数（正射模式）────────────────────────────────────────────
    //
    //  设计目标：
    //   • 相机在边界内侧巡行，pitch = -90°（正射/nadir）
    //   • 可见地面半径 R = H_相对 × tan(30°)（标准 60° FOV）
    //     其中 H_相对 = 相机绝对高度 alt − 地形最高点，才是真正的"地面相对高度"
    //   • 相机内缩偏移 f = 2R/3
    //     → 一帧朝中心侧可见数据跨度 = R + f = 5R/3
    //     → 令 5R/3 = D/2（D = MBR 最短边）
    //        ⟹ R = 3D/10，H_相对 = R/tan(30°) ≈ D × 0.52
    //   • 高度基准 D 取最小外接矩形（MBR）的较短边
    //     → 保证沿较长边飞时，朝中心方向一帧正好看见 D/2 的数据
    //   • alt（绝对椭球高）= H_相对 + 地形最高点 + 安全余量
    //     → 避免相机钻入地形，点云一个也看不到
    //   • heading 始终从相机指向数据中心，数据区出现在画面上半幅
    //
    const cosLat0   = Math.cos(Cesium.Math.toRadians(ext.centerLat));
    const lngMeters = ext.lngSpan * 111320 * cosLat0;   // MBR 经度方向米数
    const latMeters = ext.latSpan * 110540;              // MBR 纬度方向米数
    const minSide   = Math.min(lngMeters, latMeters);    // MBR 较短边（D）
    const maxSide   = Math.max(lngMeters, latMeters);    // MBR 较长边（用于上限）

    // 相对于地面的理想飞行高度：5R/3 = D/2 → H_rel ≈ D × 0.52
    const H_rel = minSide * 0.52;

    // 地形安全下限：数据最高地形 + 800 m 净空（防止相机入地）
    const terrainFloor = (ext.maxTerrainHeight || 0) + 800;

    // 绝对椭球高：理想高度加地形最高点，但不低于安全下限，不超过数据对角线 1.5×
    const altIdeal = H_rel + (ext.maxTerrainHeight || 0);
    const alt = Math.max(terrainFloor, Math.min(maxSide * 1.5, altIdeal));

    // 地面可见半径（米）& 内缩量（度）
    const R_m   = alt * Math.tan(Cesium.Math.toRadians(30));   // ≈ alt × 0.577
    const f_m   = R_m * (2 / 3);                                // 内缩偏移量
    const lngIn = f_m / (111320 * cosLat0);                     // 度
    const latIn = f_m / 110540;                                  // 度

    // ── 2. 内缩矩形巡航路径（顺时针：南→东→北→西）────────────────────────
    const W = ext.minLng + lngIn,  E = ext.maxLng - lngIn;
    const S = ext.minLat + latIn,  N = ext.maxLat - latIn;

    // 防止内缩过度（数据区太小时退化为中心点）
    const lngSpan = Math.max(E - W, 0);
    const latSpan = Math.max(N - S, 0);

    // 圆角半径：f 的 80 %，不超过边长一半（保证路径不自交）
    const crLng = Math.min(lngIn * 0.80, lngSpan / 2);
    const crLat = Math.min(latIn * 0.80, latSpan / 2);
    const sLng  = Math.max(lngSpan - crLng * 2, 0);   // 直线段经度跨度
    const sLat  = Math.max(latSpan - crLat * 2, 0);   // 直线段纬度跨度

    // Ramanujan 1/4 椭圆弧近似长度（度单位，用于等弧长参数化）
    const qArc = (crLng > 0 && crLat > 0)
        ? (Math.PI * (3 * (crLng + crLat) -
            Math.sqrt((3 * crLng + crLat) * (crLng + 3 * crLat)))) / 4
        : 0;

    // 8 段（4 直线 + 4 圆角），顺时针
    const segs = [
        { type: 'line', len: sLng  },  // 南边 W→E
        { type: 'arc',  len: qArc  },  // SE 角
        { type: 'line', len: sLat  },  // 东边 S→N
        { type: 'arc',  len: qArc  },  // NE 角
        { type: 'line', len: sLng  },  // 北边 E→W
        { type: 'arc',  len: qArc  },  // NW 角
        { type: 'line', len: sLat  },  // 西边 N→S
        { type: 'arc',  len: qArc  },  // SW 角
    ];
    const totalLen = segs.reduce((s, sg) => s + sg.len, 0) || 1e-9;

    // 各圆弧段中点的归一化 t（用于转角减速）
    const arcMidTs = [];
    let _cum = 0;
    for (const sg of segs) {
        if (sg.type === 'arc' && sg.len > 0)
            arcMidTs.push((_cum + sg.len / 2) / totalLen);
        _cum += sg.len;
    }

    // 路径采样函数：归一化 t ∈ [0,1) → { lng, lat }
    function samplePath(p) {
        let d = ((p % 1) + 1) % 1 * totalLen;
        // 南边
        if (d <= sLng) return { lng: W + crLng + d, lat: S };
        d -= sLng;
        // SE 圆角
        if (d <= qArc) {
            const θ = -Math.PI / 2 + (qArc > 0 ? d / qArc : 0) * (Math.PI / 2);
            return { lng: E - crLng + crLng * Math.cos(θ), lat: S + crLat + crLat * Math.sin(θ) };
        }
        d -= qArc;
        // 东边
        if (d <= sLat) return { lng: E, lat: S + crLat + d };
        d -= sLat;
        // NE 圆角
        if (d <= qArc) {
            const θ = (qArc > 0 ? d / qArc : 0) * (Math.PI / 2);
            return { lng: E - crLng + crLng * Math.cos(θ), lat: N - crLat + crLat * Math.sin(θ) };
        }
        d -= qArc;
        // 北边
        if (d <= sLng) return { lng: E - crLng - d, lat: N };
        d -= sLng;
        // NW 圆角
        if (d <= qArc) {
            const θ = Math.PI / 2 + (qArc > 0 ? d / qArc : 0) * (Math.PI / 2);
            return { lng: W + crLng + crLng * Math.cos(θ), lat: N - crLat + crLat * Math.sin(θ) };
        }
        d -= qArc;
        // 西边
        if (d <= sLat) return { lng: W, lat: N - crLat - d };
        d -= sLat;
        // SW 圆角
        const θ = Math.PI + (qArc > 0 ? d / qArc : 0) * (Math.PI / 2);
        return { lng: W + crLng + crLng * Math.cos(θ), lat: S + crLat + crLat * Math.sin(θ) };
    }

    // ── 3. 转角减速因子（余弦平滑，转角中心降至 0.35x）──────────────────
    const CORNER_HALF = 0.060;   // 减速区宽度（归一化 t）
    const MIN_SPD     = 0.35;    // 转角中心最低速比
    function cornerSpeedFactor(t) {
        if (!arcMidTs.length) return 1;
        let nearest = Infinity;
        for (const ct of arcMidTs) {
            const d = Math.min(Math.abs(t - ct), Math.abs(t - ct + 1), Math.abs(t - ct - 1));
            if (d < nearest) nearest = d;
        }
        if (nearest >= CORNER_HALF) return 1;
        const blend = 0.5 + 0.5 * Math.cos(Math.PI * (1 - nearest / CORNER_HALF));
        return MIN_SPD + (1 - MIN_SPD) * blend;
    }

    // ── 4. 正射航向：从相机位置指向数据中心（数据区显示在画面上半幅）────
    function headingToCenter(lng, lat) {
        const cosLat = Math.cos(Cesium.Math.toRadians(lat));
        const dE = (ext.centerLng - lng) * 111320 * cosLat;
        const dN = (ext.centerLat - lat) * 110540;
        return Math.atan2(dE, dN);   // Cesium heading：北=0，东=π/2
    }

    // ── 5. 飞入起点 ───────────────────────────────────────────────────────
    let t = 0, lastMs = null, curHeading = null, patrolStarted = false;

    const sp0    = samplePath(0);
    const initH  = headingToCenter(sp0.lng, sp0.lat);

    // 先以斜视飞入，抵达后切换正射，避免过渡突兀
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(sp0.lng, sp0.lat, alt * 1.5),
        orientation: { heading: initH, pitch: Cesium.Math.toRadians(-40), roll: 0 },
        duration: 2.2,
        complete: () => {
            if (!ROAM.active || ROAM.mode !== 'area-patrol') return;
            // 短暂过渡到正射
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(sp0.lng, sp0.lat, alt),
                orientation: { heading: initH, pitch: Cesium.Math.toRadians(-89.9), roll: 0 },
                duration: 0.8,
                complete: () => { if (ROAM.active && ROAM.mode === 'area-patrol') patrolStarted = true; },
            });
        },
    });

    // ── 6. 逐帧更新（正射巡航）───────────────────────────────────────────
    ROAM.listener = function() {
        if (!patrolStarted) return;
        const nowMs = performance.now();
        const dt = lastMs ? Math.min((nowMs - lastMs) / 1000, 0.08) : 0.016;
        lastMs = nowMs;

        // 速度：speed=1 约 70 s 一圈；转角减速
        const sf = cornerSpeedFactor(t);
        t = (t + ROAM.speed * sf * (1 / 70) * dt) % 1;

        const { lng, lat } = samplePath(t);
        if (!isFinite(lng) || !isFinite(lat)) return;

        // 目标航向：指向数据中心（正射下即画面"上"方向）
        const targetH = headingToCenter(lng, lat);

        // 平滑 SLERP 航向插值：直线段快速跟随，转角段柔缓过渡
        if (curHeading === null) curHeading = targetH;
        const smoothK = 1.8 + sf * 3.5;
        const diff    = ((targetH - curHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        curHeading   += diff * Math.min(1, dt * smoothK);

        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(lng, lat, alt),
            orientation: {
                heading: curHeading,
                pitch:   Cesium.Math.toRadians(-89.9),   // 正射；避免万向锁用 -89.9°
                roll:    0,
            },
        });
    };
    viewer.scene.postUpdate.addEventListener(ROAM.listener);
}

// =============================== 自定义航线漫游 =================================
function startCustomRoam() {
    if (ROAM.waypoints.length < 2) { toast('至少需要2个航点', 'warning'); stopRoaming(); return; }
    if (ROAM.waypointMode) toggleWaypointMode();
    ROAM.waypointIndex = 0;
    const statusEl = document.querySelector('#roamStatus span:last-child');

    // ---- Haversine 两点距离(km) ----
    function calcDistKm(from, to) {
        const R = 6371;
        const dLat = Cesium.Math.toRadians(to.lat - from.lat);
        const dLng = Cesium.Math.toRadians(to.lng - from.lng);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(Cesium.Math.toRadians(from.lat)) *
                  Math.cos(Cesium.Math.toRadians(to.lat)) *
                  Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    const AIRCRAFT_AGL   = 500;   // m 离地净高（兼顾地形起伏误差，保持在地面之上）
    const BASE_SPEED_KMH = 260;   // km/h 巡航速度
    const LOOK_AHEAD_KM  = 0.55;  // km 前视距离（更早预判转弯）
    const MAX_BANK_DEG   = 22;    // °  最大过弯倾斜
    const BANK_SMOOTH    = 0.14;  // EMA 平滑系数（值越大响应越快）
    const NOSE_DOWN_RAD  = Cesium.Math.toRadians(-18); // 巡航低头配平角（-18° 可清晰看到地面和点云，同时保留飞行感）

    const segmentMeta = ROAM.waypoints.map((wp, i) => {
        const nextWp = ROAM.waypoints[(i + 1) % ROAM.waypoints.length];
        return { from: wp, to: nextWp, distKm: Math.max(calcDistKm(wp, nextWp), 0.001) };
    });

    // ---- 跨段前向采样：从 (segIdx, progressKm) 向前 km 处的位置 ----
    function lookAheadPos(segIdx, progressKm, km) {
        let idx = segIdx, prog = progressKm + km;
        for (let guard = 0; guard < segmentMeta.length; guard++) {
            const seg = segmentMeta[idx];
            if (prog <= seg.distKm) {
                const r = prog / seg.distKm;
                return {
                    lng: seg.from.lng + (seg.to.lng - seg.from.lng) * r,
                    lat: seg.from.lat + (seg.to.lat - seg.from.lat) * r,
                    alt: ((seg.from.height || 0) + ((seg.to.height || 0) - (seg.from.height || 0)) * r) + AIRCRAFT_AGL,
                };
            }
            prog -= seg.distKm;
            idx = (idx + 1) % segmentMeta.length;
        }
        const wp = ROAM.waypoints[0];
        return { lng: wp.lng, lat: wp.lat, alt: (wp.height || 0) + AIRCRAFT_AGL };
    }

    let segIdx = 0, segProgressKm = 0;
    let lastMs = null, smoothRoll = 0, lastHeading = null;
    let roamStarted = false;

    // ---- 飞入第一个航点，落地后启动 ----
    const wp0  = ROAM.waypoints[0];
    const la0  = lookAheadPos(0, 0, LOOK_AHEAD_KM);
    const c0   = Math.cos(Cesium.Math.toRadians(wp0.lat));
    const h0   = Math.atan2((la0.lng - wp0.lng) * 111320 * c0, (la0.lat - wp0.lat) * 110540);
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(wp0.lng, wp0.lat, (wp0.height || 0) + AIRCRAFT_AGL + 500),
        orientation: { heading: h0, pitch: Cesium.Math.toRadians(-18), roll: 0 },
        duration: 2.5,
        complete: () => {
            if (ROAM.active && ROAM.mode === 'custom') {
                roamStarted = true;
                statusEl.textContent = `✈️ 飞行中 (航段 1/${ROAM.waypoints.length})`;
            }
        },
    });

    ROAM.listener = function(scene, _time) {
        if (!roamStarted || !ROAM.active) return;

        // 真实帧间 dt（JulianDate 无 secondsPerTick，必须用 performance.now）
        const nowMs = performance.now();
        const dt = lastMs ? Math.min((nowMs - lastMs) / 1000, 0.1) : 0.016;
        lastMs = nowMs;

        // ---- 推进位置 ----
        segProgressKm += (BASE_SPEED_KMH * ROAM.speed) / 3600 * dt;
        let seg = segmentMeta[segIdx];
        while (seg && segProgressKm >= seg.distKm) {
            segProgressKm -= seg.distKm;
            segIdx = (segIdx + 1) % segmentMeta.length;
            seg = segmentMeta[segIdx];
            ROAM.waypointIndex = segIdx;
            statusEl.textContent = `✈️ 飞行中 (航段 ${segIdx + 1}/${ROAM.waypoints.length})`;
        }
        if (!seg) return;

        const r   = segProgressKm / seg.distKm;
        const lng = seg.from.lng + (seg.to.lng - seg.from.lng) * r;
        const lat = seg.from.lat + (seg.to.lat - seg.from.lat) * r;
        // 插值航点高度（椭球绝对高）
        const interpH = (seg.from.height || 0) + ((seg.to.height || 0) - (seg.from.height || 0)) * r;
        // 用 globe.getHeight() 实时读取当前位置地形高——瓦片未加载时返回 undefined，
        // 取 interpH 与实测地形高两者较大值，确保相机永远在地表之上
        const carto_now = Cesium.Cartographic.fromDegrees(lng, lat);
        const liveTerrainH = viewer.scene.globe.getHeight(carto_now);
        const terrainBase = (Number.isFinite(liveTerrainH) && liveTerrainH > interpH)
            ? liveTerrainH : interpH;
        const alt = terrainBase + AIRCRAFT_AGL;

        // ---- 跨段前视：heading / pitch ----
        const la      = lookAheadPos(segIdx, segProgressKm, LOOK_AHEAD_KM);
        const cosLat  = Math.cos(Cesium.Math.toRadians(lat));
        const dE      = (la.lng - lng) * 111320 * cosLat;
        const dN      = (la.lat - lat) * 110540;
        const dU      = la.alt - alt;
        const hDist   = Math.sqrt(dE * dE + dN * dN) || 0.001;
        const heading = Math.atan2(dE, dN);
        // 前视俯仰角 + 固定低头配平（模拟巡航飞机姿态）
        const pitchRaw = Math.atan2(dU, hDist) + NOSE_DOWN_RAD;
        const pitch   = Math.max(
            Cesium.Math.toRadians(-28),
            Math.min(Cesium.Math.toRadians(5), pitchRaw)
        );

        // ---- 过弯倾斜（roll）：角速度 → 目标倾角 → EMA 平滑 ----
        let dH = lastHeading !== null ? heading - lastHeading : 0;
        while (dH >  Math.PI) dH -= 2 * Math.PI;   // 归一化 [-π, π]
        while (dH < -Math.PI) dH += 2 * Math.PI;
        // 偏航角速度 → 飞机左/右压坡（右转→右压 → roll 为正）
        const omegaRad = dH / dt;                   // rad/s
        const targetRoll = Cesium.Math.toRadians(
            Math.max(-MAX_BANK_DEG, Math.min(MAX_BANK_DEG, omegaRad * (MAX_BANK_DEG / 0.6)))
        );
        smoothRoll = smoothRoll * (1 - BANK_SMOOTH) + targetRoll * BANK_SMOOTH;
        lastHeading = heading;

        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(lng, lat, alt),
            orientation: { heading, pitch, roll: smoothRoll },
        });
    };

    viewer.scene.postUpdate.addEventListener(ROAM.listener);
}

function startRoaming(mode) {
    stopRoaming();
    let ext = null;
    if (mode !== 'custom') {
        ext = getDataExtent();
        if (!ext) { toast('请先加载数据', 'warning'); return; }
    }
    ROAM.mode = mode;
    ROAM.active = true;
    document.querySelector('.roam-card[data-mode="' + mode + '"]').classList.add('active');
    const statusEl = document.getElementById('roamStatus');
    statusEl.classList.add('active');
    const labels = { 'high-altitude': '🛩️ 高空俯瞰中...', 'low-orbit': '🔄 低空环绕中...', 'area-patrol': '🚁 区域巡视中...', 'custom': '✈️ 自定义漫游中...' };
    statusEl.querySelector('span:last-child').textContent = labels[mode] || '漫游中...';
    document.getElementById('roamStartBtn').style.display = 'none';
    document.getElementById('roamStopBtn').style.display = 'flex';
    if (mode === 'high-altitude') startHighAltitudeOverview(ext);
    else if (mode === 'low-orbit') startLowAltitudeOrbit(ext);
    else if (mode === 'area-patrol') startAreaPatrol(ext);
    else if (mode === 'custom') startCustomRoam();
}

// =========================== Cesium 交互事件 ===========================
export function initCesiumEvents() {
    // 折线图关闭
    document.getElementById('lineChartCloseBtn')?.addEventListener('click', function() {
        document.getElementById('lineChartContainer').classList.remove('visible');
    });

    // 点选查询 & 标注放置
    viewer.screenSpaceEventHandler.setInputAction(function(movement) {
        // —— 标注放置优先 ——
        if (TB.annotateActive) {
            const cartesian = viewer.scene.pickPosition(movement.position)
                || viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
            _placeAnnotation(cartesian);
            return;
        }

        if (!STATE.pickMode) return;
        const picked = scene.pick(movement.position);
        let cartographic = null;
        if (picked && picked.primitive) {
            try {
                const pos = picked.primitive.position;
                if (pos) { const c3 = pos instanceof Cesium.Cartesian3 ? pos : pos.getValue(viewer.clock.currentTime); if (c3) cartographic = Cesium.Cartographic.fromCartesian(c3); }
            } catch (e) { cartographic = null; }
        }
        if (!cartographic) { const cartesian = viewer.camera.pickEllipsoid(movement.position, scene.globe.ellipsoid); if (cartesian) cartographic = Cesium.Cartographic.fromCartesian(cartesian); }
        if (!cartographic) return;
        const lng = Cesium.Math.toDegrees(cartographic.longitude);
        const lat = Cesium.Math.toDegrees(cartographic.latitude);
        findAndShowPointData(lng, lat);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 航点拾取
    const waypointPickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    waypointPickHandler.setInputAction(function(click) {
        if (!ROAM.waypointMode) return;
        const cartesian = viewer.scene.pickPosition(click.position);
        if (!cartesian) { toast('无法获取该位置坐标，请点击地球表面', 'warning'); return; }
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        if (!carto || !isFinite(carto.longitude) || !isFinite(carto.latitude)) { toast('无法获取有效坐标', 'warning'); return; }
        const lng = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);

        // pickPosition 在地形瓦片未加载时可能返回椭球面高度（≈0），
        // 用 globe.getHeight() 作为兜底，取两者较大值确保在地表之上
        let height = carto.height || 0;
        const globeH = viewer.scene.globe.getHeight(carto);
        if (Number.isFinite(globeH) && globeH > height) height = globeH;

        if (isValidLngLat(lng, lat)) { addWaypoint(lng, lat, height); } else { toast('坐标无效', 'warning'); }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function findAndShowPointData(lng, lat) {
    let allData = [];
    for (const ds of STATE.datasets) { if (ds.visible && ds.data) allData = allData.concat(ds.data); }
    if (!allData.length) {
        document.getElementById('pickedPointInfo').style.display = 'none';
        document.getElementById('lineChartContainer').classList.remove('visible');
        toast('没有可查询的数据', 'warning');
        return;
    }
    let best = null, bestDist = Infinity;
    for (const d of allData) { const dx = d.longitude - lng, dy = d.latitude - lat; const dist = dx * dx + dy * dy; if (dist < bestDist) { bestDist = dist; best = d; } }
    const searchRadiusDeg = 0.015;
    if (!best || Math.sqrt(bestDist) > searchRadiusDeg) {
        document.getElementById('pickedPointInfo').style.display = 'none';
        document.getElementById('lineChartContainer').classList.remove('visible');
        toast('未在点击位置附近找到数据点', 'info');
        return;
    }
    STATE.pickedPoint = best;
    showPickedPointInfo(best);
    highlightPickedPoint(best);
}

function showPickedPointInfo(point) {
    const infoDiv = document.getElementById('pickedPointInfo');
    let allData = [];
    for (const ds of STATE.datasets) { if (ds.visible && ds.data) allData = allData.concat(ds.data); }
    const timeSeries = [];
    const seenYears = new Set();
    const TOL = 0.001;
    for (const d of allData) {
        if (Math.abs(d.longitude - point.longitude) < TOL && Math.abs(d.latitude - point.latitude) < TOL && d.year != null) {
            const yKey = String(d.year);
            if (!seenYears.has(yKey)) { seenYears.add(yKey); timeSeries.push({ year: d.year, deformation: d.deformation }); }
        }
    }
    timeSeries.sort((a, b) => String(a.year).localeCompare(String(b.year)));
    const defColor = point.deformation >= 0 ? '#6ab0ff' : '#ff6b6b';
    let html = `
        <div style="margin-bottom:8px;font-weight:600;color:#4A9EFF;font-size:13px;">
            📍 选中点信息
            <span style="font-weight:400;font-size:11px;color:rgba(255,255,255,0.3);margin-left:6px;">
                (${point.longitude.toFixed(5)}, ${point.latitude.toFixed(5)})
            </span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px;">
            <div style="color:rgba(255,255,255,0.4);">经度</div>
            <div style="text-align:right;color:#c8d0dc;font-family:monospace;">${point.longitude.toFixed(5)}°</div>
            <div style="color:rgba(255,255,255,0.4);">纬度</div>
            <div style="text-align:right;color:#c8d0dc;font-family:monospace;">${point.latitude.toFixed(5)}°</div>
            <div style="color:rgba(255,255,255,0.4);">形变值</div>
            <div style="text-align:right;color:${defColor};font-weight:600;font-family:monospace;">${point.deformation >= 0 ? '+' : ''}${point.deformation.toFixed(4)}</div>`;
    if (point.year != null) {
        html += `<div style="color:rgba(255,255,255,0.4);">当前年份</div><div style="text-align:right;color:#c8d0dc;">${point.year}</div>`;
    }
    html += `</div>`;
    if (timeSeries.length >= 2) {
        const maxAbs = arrayMax(timeSeries.map(d => Math.abs(d.deformation)));
        const trend = timeSeries[timeSeries.length - 1].deformation - timeSeries[0].deformation;
        const avg = timeSeries.reduce((s, d) => s + d.deformation, 0) / timeSeries.length;
        html += `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);"><div style="font-size:12px;font-weight:500;color:#c8d0dc;margin-bottom:6px;">📈 时间序列变化</div><div style="display:flex;flex-direction:column;gap:3px;">`;
        for (const ts of timeSeries) {
            const pct = maxAbs > 0 ? Math.abs(ts.deformation) / maxAbs * 100 : 0;
            const isNeg = ts.deformation < 0;
            html += `<div style="display:flex;align-items:center;gap:6px;font-size:11px;">
                <span style="min-width:34px;color:rgba(255,255,255,0.4);font-family:monospace;">${ts.year}</span>
                <div style="flex:1;height:16px;background:rgba(255,255,255,0.04);border-radius:4px;overflow:hidden;">
                    <div style="height:100%;width:${Math.max(pct, 2)}%;border-radius:4px;${isNeg ? 'background:#ff6b6b;' : 'background:#4A9EFF;'}"></div>
                </div>
                <span style="min-width:50px;text-align:right;font-weight:500;font-family:monospace;color:${isNeg ? '#ff6b6b' : '#6ab0ff'};">${ts.deformation >= 0 ? '+' : ''}${ts.deformation.toFixed(3)}</span>
            </div>`;
        }
        html += `</div><div style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.35);display:flex;gap:12px;">
            <span>平均: <span style="color:#c8d0dc;">${avg.toFixed(4)}</span></span>
            <span>趋势: <span style="color:${trend >= 0 ? '#6ab0ff' : '#ff6b6b'};">${trend >= 0 ? '↑' : '↓'}${Math.abs(trend).toFixed(4)}</span></span>
            <span>跨 ${timeSeries.length} 个周期</span></div></div>`;
    } else {
        html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(255,255,255,0.3);">
            ℹ️ ${timeSeries.length === 1 ? '该点仅有一个年份数据' : '该点无年份信息'}，无法展示时间序列</div>`;
    }
    infoDiv.innerHTML = html;
    infoDiv.style.display = 'block';
    drawLineChart(timeSeries);
}

function drawLineChart(timeSeries) {
    const container = document.getElementById('lineChartContainer');
    const canvas = document.getElementById('lineChartCanvas');
    if (!timeSeries || timeSeries.length < 2) { container.classList.remove('visible'); return; }
    container.classList.add('visible');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth;
    const displayH = canvas.clientHeight;
    if (displayW === 0 || displayH === 0) return;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    ctx.scale(dpr, dpr);
    const W = displayW, H = displayH;
    const pad = { top: 28, right: 16, bottom: 38, left: 54 };
    const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
    if (cw <= 0 || ch <= 0) return;
    ctx.clearRect(0, 0, W, H);
    const years = timeSeries.map(d => String(d.year));
    const vals = timeSeries.map(d => d.deformation);
    const vmin = arrayMin(vals), vmax = arrayMax(vals);
    const vrange = vmax - vmin || 1;
    const margin = vrange * 0.12;
    const yMin = vmin - margin, yMax = vmax + margin, yRange = yMax - yMin || 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    const gridCount = 4;
    ctx.font = '10px "Segoe UI", "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= gridCount; i++) {
        const y = pad.top + ch * (1 - i / gridCount);
        const val = yMin + yRange * (i / gridCount);
        ctx.beginPath();
        ctx.moveTo(pad.left, Math.round(y) + 0.5);
        ctx.lineTo(W - pad.right, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillText(val.toFixed(3), pad.left - 8, y);
    }
    const points = vals.map((v, i) => ({ x: pad.left + cw * (vals.length > 1 ? i / (vals.length - 1) : 0.5), y: pad.top + ch * (1 - (v - yMin) / yRange) }));
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, 'rgba(74, 158, 255, 0.20)');
    grad.addColorStop(0.5, 'rgba(74, 158, 255, 0.08)');
    grad.addColorStop(1, 'rgba(74, 158, 255, 0.01)');
    ctx.beginPath();
    ctx.moveTo(points[0].x, pad.top + ch);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = '#4A9EFF';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px "Segoe UI", "PingFang SC", sans-serif';
    const maxLabels = 8;
    const step = Math.max(1, Math.ceil(years.length / maxLabels));
    for (let i = 0; i < years.length; i += step) ctx.fillText(years[i], points[i].x, pad.top + ch + 8);
    if (years.length > 1 && (years.length - 1) % step !== 0) ctx.fillText(years[years.length - 1], points[points.length - 1].x, pad.top + ch + 8);
    for (let i = 0; i < points.length; i++) {
        const color = vals[i] >= 0 ? '#6ab0ff' : '#ff6b6b';
        ctx.beginPath();
        ctx.arc(points[i].x, points[i].y, 7, 0, Math.PI * 2);
        ctx.fillStyle = vals[i] >= 0 ? 'rgba(106, 176, 255, 0.15)' : 'rgba(255, 107, 107, 0.15)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(points[i].x, points[i].y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

function isValidLngLat(lng, lat) { return typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180 && typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90; }

// =========================== 工具栏辅助函数 ===========================

function _terrainStatusLabel() {
    const status = STATE.terrainStatus;
    if (status?.lastError) return '地形瓦片失败';
    if (status?.provider === 'EllipsoidTerrainProvider' || status?.provider === 'none') return '无真实地形';
    return '地形加载中';
}

/** 底部状态栏：鼠标坐标更新 */
function _updateStatusCoord(screenPos) {
    if (!viewer) return;
    const cartesian = viewer.camera.pickEllipsoid(screenPos, viewer.scene.globe.ellipsoid);
    if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lng = Cesium.Math.toDegrees(carto.longitude).toFixed(5);
        const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(5);
        // 尝试取地形高程
        const terrainH = viewer.scene.globe.getHeight(carto);
        const alt = Number.isFinite(terrainH) ? terrainH.toFixed(1) + ' m' : _terrainStatusLabel();
        document.getElementById('sbLng').textContent = lng + '°';
        document.getElementById('sbLat').textContent = lat + '°';
        document.getElementById('sbAlt').textContent = alt;
    } else {
        document.getElementById('sbLng').textContent = '—';
        document.getElementById('sbLat').textContent = '—';
        document.getElementById('sbAlt').textContent = '—';
    }
}

/** 顶部缩放值显示 */
function _updateZoomLabel() {
    if (!viewer) return;
    const h = viewer.camera.positionCartographic?.height;
    if (h == null) return;
    let label;
    if (h >= 1e6)       label = (h / 1e6).toFixed(1) + ' Mm';
    else if (h >= 1000) label = (h / 1000).toFixed(1) + ' km';
    else                label = h.toFixed(0) + ' m';
    const el = document.getElementById('tbZoomVal');
    if (el) el.textContent = label;
}

/** 底部比例尺更新 */
function _updateScaleBar() {
    if (!viewer) return;
    const scene = viewer.scene;
    const canvas = scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const left   = new Cesium.Cartesian2(0, canvas.clientHeight / 2);
    const cCenter = viewer.camera.pickEllipsoid(center, scene.globe.ellipsoid);
    const cLeft   = viewer.camera.pickEllipsoid(left,   scene.globe.ellipsoid);
    if (!cCenter || !cLeft) return;
    const dist = Cesium.Cartesian3.distance(cCenter, cLeft); // 半个屏幕的实际距离（米）
    // 比例尺宽度固定 80px → 对应实际距离 dist 米
    // 取整为友好数字
    const raw = dist;
    const nice = _niceScaleValue(raw);
    const barPx = Math.round(80 * nice / dist);
    const lineEl = document.getElementById('scaleBarLine');
    const textEl = document.getElementById('scaleBarText');
    if (lineEl) lineEl.style.width = Math.min(barPx, 150) + 'px';
    if (textEl) {
        if (nice >= 1000) textEl.textContent = (nice / 1000).toFixed(0) + ' km';
        else              textEl.textContent = nice.toFixed(0) + ' m';
    }
}

function _niceScaleValue(v) {
    const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
        10000, 20000, 50000, 100000, 200000, 500000, 1000000];
    let best = candidates[0];
    for (const c of candidates) {
        if (Math.abs(c - v) < Math.abs(best - v)) best = c;
        if (c > v * 1.5) break;
    }
    return best;
}

/** 底部色带同步 STATE 色带方案 */
export function updateStatusColorRamp() {
    _updateColorRampBar();
}

function _updateColorRampBar() {
    const gradient = document.getElementById('colorRampGradient');
    const crMin = document.getElementById('crMin');
    const crMax = document.getElementById('crMax');
    if (!gradient) return;

    // 先生成最新色带并同步到所有色带元素
    updateColorRampPreview();

    // 显示 colorMin / colorMax
    if (STATE.colorMin != null && STATE.colorMax != null) {
        crMin.textContent = STATE.colorMin.toFixed(2);
        crMax.textContent = STATE.colorMax.toFixed(2);
    } else {
        // 从所有可见数据集计算
        let mn = Infinity, mx = -Infinity;
        for (const ds of STATE.datasets) {
            if (!ds.visible || !ds.data) continue;
            for (const d of ds.data) {
                if (d.deformation < mn) mn = d.deformation;
                if (d.deformation > mx) mx = d.deformation;
            }
        }
        crMin.textContent = isFinite(mn) ? mn.toFixed(2) : '—';
        crMax.textContent = isFinite(mx) ? mx.toFixed(2) : '—';
    }
}

// =========================== 测量工具 ===========================
let _measureHandler = null;

function _startMeasure(mode) {
    _stopMeasure();
    TB.measureMode = mode;
    TB.measurePoints = [];
    document.getElementById('tbMeasureBtn').classList.add('active');
    const tip = document.getElementById('measureTip');
    document.getElementById('measureTipText').textContent = mode === 'distance'
        ? '📐 单击添加测量点，双击结束距离测量'
        : '📐 单击添加折点，双击结束面积测量';
    tip.style.display = 'flex';
    viewer.scene.canvas.style.cursor = 'crosshair';

    _measureHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    // 单击添加点
    _measureHandler.setInputAction((click) => {
        const cartesian = viewer.scene.pickPosition(click.position)
            || viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);
        if (!cartesian) return;
        TB.measurePoints.push(cartesian);
        _drawMeasurePoint(cartesian);
        if (TB.measurePoints.length >= 2) _updateMeasureResult();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 双击结束
    _measureHandler.setInputAction(() => {
        _finalizeMeasure();
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}

function _drawMeasurePoint(cartesian) {
    const e = viewer.entities.add({
        position: cartesian,
        point: { pixelSize: 8, color: Cesium.Color.fromCssColorString('#4A9EFF'), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5 }
    });
    TB.measureEntities.push(e);
    // 如果有 ≥2 点，画线段
    if (TB.measurePoints.length >= 2 && TB.measureMode === 'distance') {
        const line = viewer.entities.add({
            polyline: {
                positions: [...TB.measurePoints],
                width: 2.5,
                material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.15, color: Cesium.Color.fromCssColorString('#4A9EFF').withAlpha(0.9) }),
            }
        });
        TB.measureEntities.push(line);
    }
}

function _updateMeasureResult() {
    const pts = TB.measurePoints;
    if (TB.measureMode === 'distance') {
        let total = 0;
        for (let i = 1; i < pts.length; i++)
            total += Cesium.Cartesian3.distance(pts[i - 1], pts[i]);
        const label = total >= 1000
            ? (total / 1000).toFixed(2) + ' km'
            : total.toFixed(1) + ' m';
        document.getElementById('measureTipText').textContent = `📏 距离：${label}（双击结束）`;
    } else {
        // 面积：用球面多边形近似（Shoelace on cartographics）
        const area = _calcPolygonArea(pts);
        const label = area >= 1e6
            ? (area / 1e6).toFixed(2) + ' km²'
            : area.toFixed(0) + ' m²';
        document.getElementById('measureTipText').textContent = `📐 面积：${label}（双击结束）`;
        // 绘制多边形轮廓
        TB.measureEntities.filter(e => e._polygon)
            .forEach(e => viewer.entities.remove(e));
        const poly = viewer.entities.add({
            polygon: {
                hierarchy: pts,
                material: Cesium.Color.fromCssColorString('#4A9EFF').withAlpha(0.12),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString('#4A9EFF'),
            }
        });
        TB.measureEntities.push(poly);
    }
}

function _calcPolygonArea(cartesians) {
    if (cartesians.length < 3) return 0;
    // 转成笛卡尔2D（局部平面近似）
    const R = 6371000;
    const ref = Cesium.Cartographic.fromCartesian(cartesians[0]);
    const pts = cartesians.map(c => {
        const carto = Cesium.Cartographic.fromCartesian(c);
        const x = (carto.longitude - ref.longitude) * Math.cos(ref.latitude) * R;
        const y = (carto.latitude - ref.latitude) * R;
        return { x, y };
    });
    let area = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts[i].x * pts[j].y;
        area -= pts[j].x * pts[i].y;
    }
    return Math.abs(area) / 2;
}

function _finalizeMeasure() {
    const tipText = document.getElementById('measureTipText');
    tipText.textContent += ' ✓ 已完成';
    viewer.scene.canvas.style.cursor = '';
    if (_measureHandler) { _measureHandler.destroy(); _measureHandler = null; }
}

function _stopMeasure() {
    TB.measureMode = null;
    TB.measurePoints = [];
    TB.measureEntities.forEach(e => viewer.entities.remove(e));
    TB.measureEntities = [];
    if (_measureHandler) { _measureHandler.destroy(); _measureHandler = null; }
    document.getElementById('tbMeasureBtn')?.classList.remove('active');
    document.getElementById('measureTip').style.display = 'none';
    viewer.scene.canvas.style.cursor = '';
}

// =========================== 标注工具 ===========================
function _cancelAnnotate() {
    TB.annotateActive = false;
    if (viewer) viewer.scene.canvas.style.cursor = '';
}

function _placeAnnotation(cartesian) {
    if (!cartesian) return;
    const text = document.getElementById('annTextInput').value.trim();
    if (!text) return;
    const color = TB.annotateColor;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lng = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);

    const entity = viewer.entities.add({
        position: cartesian,
        billboard: {
            image: _makeAnnotationIcon(color),
            width: 28, height: 28,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        },
        label: {
            text,
            font: '12px "PingFang SC","Microsoft YaHei",sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -30),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        }
    });

    const ann = { text, color, lng, lat, entity };
    TB.annotations.push(ann);
    _renderAnnotationList();
    document.getElementById('annTextInput').value = '';
    _cancelAnnotate();
    viewer.scene.canvas.style.cursor = '';
    toast('标注已添加', 'success');
}

function _makeAnnotationIcon(color) {
    const canvas = document.createElement('canvas');
    canvas.width = 28; canvas.height = 28;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(14, 12, 10, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 小尾巴
    ctx.beginPath();
    ctx.moveTo(10, 20); ctx.lineTo(14, 28); ctx.lineTo(18, 20);
    ctx.fillStyle = color;
    ctx.fill();
    return canvas.toDataURL();
}

function _renderAnnotationList() {
    const list = document.getElementById('annList');
    if (!list) return;
    if (!TB.annotations.length) { list.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.25);text-align:center;padding:8px;">暂无标注</div>'; return; }
    list.innerHTML = TB.annotations.map((a, i) => `
        <div class="ann-item">
            <div class="ann-dot" style="background:${a.color};"></div>
            <div class="ann-text">${a.text}</div>
            <div class="ann-del" data-idx="${i}">✕</div>
        </div>
    `).join('');
    list.querySelectorAll('.ann-del').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            viewer.entities.remove(TB.annotations[idx].entity);
            TB.annotations.splice(idx, 1);
            _renderAnnotationList();
        });
    });
}

// =========================== IDW 插值 / TIN 事件 ===========================
(function initInterpEvents() {
    // ── TIN 量化格滑块实时预览 ─────────────────────────────────────────────
    const tinCellEl    = document.getElementById('tinCellSize');
    const tinCellValEl = document.getElementById('tinCellSizeVal');
    if (tinCellEl) {
        tinCellEl.addEventListener('input', () => {
            if (tinCellValEl) tinCellValEl.textContent = parseInt(tinCellEl.value) === 0 ? '自适应' : tinCellEl.value + ' m';
        });
    }

    // ── 生成 IDW 热力图 ─────────────────────────────────────────────────────
    document.getElementById('btnRunIDW')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnRunIDW');
        const statusBar = document.getElementById('idwStatusBar');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 计算中...'; }
        if (statusBar) { statusBar.style.display = 'block'; statusBar.textContent = '正在插值，请稍候...'; }

        await new Promise(r => setTimeout(r, 20)); // 让 UI 先刷新

        try {
            const { renderIDWHeatmap } = await import('../render/tin.js');
            const result = await renderIDWHeatmap({
                colorScheme: STATE.colorScheme || 'blue-white-red',
            });
            if (result && statusBar) {
                statusBar.textContent = `✓ 网格 ${result.cols}×${result.rows} · 形变 ${result.minVal.toFixed(2)} ~ ${result.maxVal.toFixed(2)} mm/yr`;
            }
        } catch (e) {
            toast('IDW 执行失败: ' + e.message, 'error');
            if (statusBar) statusBar.textContent = '✗ 失败: ' + e.message;
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '▶ 生成热力图'; }
        }
    });

    // ── 移除 IDW 层 ──────────────────────────────────────────────────────────
    document.getElementById('btnRemoveIDW')?.addEventListener('click', async () => {
        const { removeIDWLayer } = await import('../render/tin.js');
        removeIDWLayer();
        const statusBar = document.getElementById('idwStatusBar');
        if (statusBar) { statusBar.style.display = 'none'; statusBar.textContent = ''; }
        toast('IDW 热力图已移除', 'info');
    });

    // ── 生成 TIN 曲面 ────────────────────────────────────────────────────────
    document.getElementById('btnRunTIN')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnRunTIN');
        const statusBar = document.getElementById('tinStatusBar');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 构建中...'; }
        if (statusBar) { statusBar.style.display = 'block'; statusBar.textContent = '正在三角剖分，请稍候...'; }

        await new Promise(r => setTimeout(r, 20));

        try {
            const { renderTIN } = await import('../render/tin.js');
            const cellVal = parseInt(document.getElementById('tinCellSize')?.value || 0);
            const result = renderTIN({
                cellSize:     cellVal > 0 ? cellVal : undefined,
                showEdges:    document.getElementById('tinShowEdges')?.checked || false,
                colorScheme:  STATE.colorScheme || 'blue-white-red',
                colorMin:     STATE.colorMin,
                colorMax:     STATE.colorMax,
                exaggeration: STATE.exaggeration || 1,
            });
            if (result && statusBar) {
                statusBar.textContent = `✓ ${result.vertices.length} 顶点 · ${result.triangles.length} 三角面`;
            }
        } catch (e) {
            toast('TIN 执行失败: ' + e.message, 'error');
            if (statusBar) statusBar.textContent = '✗ 失败: ' + e.message;
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '▶ 生成 TIN 曲面'; }
        }
    });

    // ── 移除 TIN 层 ──────────────────────────────────────────────────────────
    document.getElementById('btnRemoveTIN')?.addEventListener('click', async () => {
        const { removeTINPrimitive } = await import('../render/tin.js');
        removeTINPrimitive();
        const statusBar = document.getElementById('tinStatusBar');
        if (statusBar) { statusBar.style.display = 'none'; statusBar.textContent = ''; }
        toast('TIN 曲面已移除', 'info');
    });
})();
