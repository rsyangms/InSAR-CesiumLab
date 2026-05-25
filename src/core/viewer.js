import { STATE } from './state.js';
import { getTerrainExaggerationRelativeHeight } from '../render/heightModel.js';

export let viewer, scene, terrainProvider;

const CESIUM_ION_ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJiOWVjYWMxNC03MzAzLTQzMTYtOTU1My1lMjdhZmQ4NzcwNzYiLCJpZCI6NDA0ODY2LCJpYXQiOjE3NzYzOTY3NDV9.dPcSXL6S5Mwx86WdgAVCmILLetlb0Cd2ufGjXw8FotA';

const COMMON_VIEWER_OPTIONS = {
    baseLayerPicker: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    geocoder: false,
    infoBox: false,
    selectionIndicator: false,
    shadows: false,
    contextOptions: {
        webgl: {
            alpha: false,
            antialias: true,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
            failIfMajorPerformanceCaveat: false,
        },
    },
};

function configureCesiumIon() {
    if (Cesium?.Ion) {
        Cesium.Ion.defaultAccessToken = CESIUM_ION_ACCESS_TOKEN;
    }
}

function getTerrainProviderName(provider) {
    if (!provider) return 'none';
    return provider.constructor?.name || 'unknown';
}

function trackTerrainProvider(provider) {
    STATE.terrainStatus = {
        provider: getTerrainProviderName(provider),
        ready: !!provider && !(provider instanceof Cesium.EllipsoidTerrainProvider),
        lastError: null,
        lastErrorAt: null,
    };

    if (!provider?.errorEvent?.addEventListener) return;
    provider.errorEvent.addEventListener(error => {
        const message = error?.message || error?.error?.message || String(error || 'terrain tile failed');
        STATE.terrainStatus.lastError = message;
        STATE.terrainStatus.lastErrorAt = Date.now();
        console.warn('[terrain] provider error:', message, error);
    });
}

export function initViewer() {
    configureCesiumIon();

    try {
        viewer = new Cesium.Viewer('cesiumContainer', {
            terrain: Cesium.Terrain.fromWorldTerrain({
                requestWaterMask: false,
                requestVertexNormals: false,
            }),
            ...COMMON_VIEWER_OPTIONS,
        });
    } catch (e) {
        try {
            viewer = new Cesium.Viewer('cesiumContainer', {
                terrain: null,
                ...COMMON_VIEWER_OPTIONS,
            });
        } catch (e2) {
            document.getElementById('cesiumContainer').innerHTML =
                '<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#161a24;color:#e0e4ec;font-size:16px;">Cesium 加载失败，请检查网络或 HTTP 服务。</div>';
        }
    }

    if (!viewer) throw new Error('Cesium 初始化失败');

    const currentScene = viewer.scene;
    currentScene.globe.enableLighting = false;
    currentScene.skyAtmosphere.show = false;
    currentScene.fog.enabled = false;
    currentScene.shadowMap.enabled = false;
    currentScene.highDynamicRange = false;
    currentScene.fxaa = false;
    currentScene.msaaSamples = 2;
    currentScene.globe.showGroundAtmosphere = false;
    currentScene.globe.maximumScreenSpaceError = 4;
    currentScene.globe.tileCacheSize = 100;
    currentScene.globe.depthTestAgainstTerrain = true;

    scene = currentScene;
    terrainProvider = scene.terrainProvider;
    trackTerrainProvider(terrainProvider);

    applyVerticalExaggeration(STATE.terrainExaggeration);
    _applyBasemap('satellite');

    setTimeout(() => {
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(104.0, 35.0, 3000000),
        });
    }, 600);

    // 降低相机变化触发阈值（默认 0.5 = 50% 变化才触发）
    // 改为 0.02 使缩放时 LOD 层级每 2% 变化就更新一次，指示器响应更灵敏
    viewer.camera.percentageChanged = 0.02;

    window.viewer = viewer;
}

export function applyVerticalExaggeration(val) {
    if (!viewer) return;

    const exaggeration = Math.max(0.1, Number(val) || 1.0);
    try {
        if (viewer.scene.verticalExaggeration !== undefined) {
            viewer.scene.verticalExaggeration = exaggeration;
            if (viewer.scene.verticalExaggerationRelativeHeight !== undefined) {
                viewer.scene.verticalExaggerationRelativeHeight = getTerrainExaggerationRelativeHeight();
            }
        } else if (viewer.scene.globe?.terrainExaggeration !== undefined) {
            viewer.scene.globe.terrainExaggeration = exaggeration;
        }
        viewer.scene.globe.depthTestAgainstTerrain = true;
    } catch (_) {}
}

// ==================== 视图和图层控制 =====================
export function applyTerrainOpacity(opacity01) {
    if (!viewer) return;
    const globe = viewer.scene.globe;
    const opacity = Math.max(0, Math.min(1, Number(opacity01) || 0));

    if (opacity >= 1.0) {
        globe.translucency.enabled = false;
    } else {
        globe.translucency.enabled = true;
        globe.translucency.frontFaceAlpha = opacity;
    }
    globe.depthTestAgainstTerrain = true;
}

let _currentBasemapLayer = null;

export function switchBasemap(type) {
    if (!viewer) return;
    _applyBasemap(type);
    document.querySelectorAll('.bm-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.bm === type);
    });
}

function _applyBasemap(type) {
    const layers = viewer.scene.imageryLayers;
    if (_currentBasemapLayer) {
        layers.remove(_currentBasemapLayer, true);
        _currentBasemapLayer = null;
    }
    layers.removeAll();

    let provider;
    switch (type) {
        case 'terrain':
            provider = new Cesium.UrlTemplateImageryProvider({
                url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
                credit: 'Esri',
                maximumLevel: 13,
            });
            break;
        case 'street':
            provider = new Cesium.OpenStreetMapImageryProvider({
                url: 'https://tile.openstreetmap.org/',
                credit: 'OpenStreetMap contributors',
                maximumLevel: 19,
            });
            break;
        case 'satellite':
        default:
            provider = new Cesium.UrlTemplateImageryProvider({
                url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                credit: 'Esri, Maxar, Earthstar Geographics',
                maximumLevel: 19,
            });
            break;
    }

    _currentBasemapLayer = layers.addImageryProvider(provider);
}
