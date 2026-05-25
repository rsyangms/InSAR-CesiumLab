// =========================== 入口文件 ===========================
import './src/core/state.js';
import { initViewer, viewer } from './src/core/viewer.js';
import { updateColorRampPreview } from './src/render/colorMap.js';
import { updateVisualization } from './src/render/pointCloud.js';
import { updateDatasetList } from './src/data/datasetManager.js';
import { renderBoundary } from './src/analysis/stats.js';
import { initPanelUI } from './src/ui/panel.js';
import { initEvents, initCesiumEvents, updateStatusColorRamp } from './src/ui/events.js';
import { STATE, toast } from './src/core/state.js';

// =========================== 初始化 ===========================
Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJiOWVjYWMxNC03MzAzLTQzMTYtOTU1My1lMjdhZmQ4NzcwNzYiLCJpZCI6NDA0ODY2LCJpYXQiOjE3NzYzOTY3NDV9.dPcSXL6S5Mwx86WdgAVCmILLetlb0Cd2ufGjXw8FotA';

initViewer();// 初始化 Cesium 视图

initPanelUI();// 初始化 UI 面板

initEvents();// 初始化事件
initCesiumEvents();

let _cameraUpdateRAF = null;
if (viewer?.camera?.changed) {
    viewer.camera.changed.addEventListener(() => {
        if (STATE._boundaryFullCoordinates) renderBoundary();
        updateDatasetList();
        if (STATE.isLoaded) {
            if (_cameraUpdateRAF) cancelAnimationFrame(_cameraUpdateRAF);
            _cameraUpdateRAF = requestAnimationFrame(() => {
                _cameraUpdateRAF = null;
                updateVisualization();
            });
        }
    });
}

// 最终初始化
document.getElementById('leftPanel').classList.add('open');
updateColorRampPreview();
updateDatasetList();
updateStatusColorRamp();
toast('InSAR可视化平台已启动，请上传数据文件', 'info');