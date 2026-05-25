// =========================== 全局状态 ===========================
export const STATE = {
    datasets: [],
    currentFile: null,
    parsedData: null,
    activeDatasetId: null,
    cameraLevel: 0,
    isLoaded: false,
    loadedFileNames: [],
    pointCloudVisible: true,
    heightOffset: 0,
    clampPointCloudToGround: true,
    surfaceClampOffset: 0,
    pointSize: 4,
    colorScheme: 'topo',
    colorMin: null,
    colorMax: null,
    exaggeration: 1.0,
    terrainExaggeration: 1.0,
    pointOpacity: 0.9,
    groundClearance: 30,
    minGroundClearance: 12,
    maxGroundClearance: 180,
    boundaryPolygons: [],
    boundaryCoordinates: null,
    boundaryPrimitive: null,
    _boundaryFullCoordinates: null,
    _boundaryLODLevel: 0,
    _boundaryEntityId: null,
    _boundaryOutlineId: null,
    _allBoundariesIds: [],
    pickMode: false,
    pickedPoint: null,
    timeData: [],
    timeIndex: 0,
    timeFilter: null,
    timePlaying: false,
    timePlayInterval: null,
    anomalyPoints: [],
    // 坐标+年份索引：Set<"lng5,lat5,year">，用于 LOD 聚合点的高效异常匹配
    anomalyIndex: null,
    // 最近一次检测的方法与参数（用于时间切换时自动刷新统计）
    _lastAnomalyMethod: null,
    fullDensityMode: false,
    renderMode: 'primitive',
    terrainOpacity: 0.65,
    terrainStatus: {
        provider: 'unknown',
        ready: false,
        lastError: null,
        lastErrorAt: null,
    },
};

export const LOD_CONFIG = [
    { level: 0, maxDist: Infinity, minDist: 100000, label: '极远' },
    { level: 1, maxDist: 100000, minDist: 50000, label: '远' },
    { level: 2, maxDist: 50000, minDist: 10000, label: '中' },
    { level: 3, maxDist: 10000, minDist: 0, label: '近' },
];

export const BOUNDARY_LOD_CONFIG = [
    { level: 0, maxDist: Infinity, minDist: 200000, label: '极远', maxVertices: 8 },
    { level: 1, maxDist: 200000, minDist: 80000, label: '远', maxVertices: 25 },
    { level: 2, maxDist: 80000, minDist: 20000, label: '中', maxVertices: 80 },
    { level: 3, maxDist: 20000, minDist: 0, label: '近', maxVertices: Infinity },
    { level: 4, maxDist: 5000, minDist: 0, label: '特近', maxVertices: Infinity },
];

export const MODULE_TITLES = {
    data: { icon: '📨', title: '数据管理' },
    analysis: { icon: '📳', title: '交互分析' },
    roam: { icon: '🎀', title: '漫游模式' },
};

export const VECTOR_MAP_SOURCES = [
    { name: '全国市级', file: 'data/市.geojson', nameKey: '市', label: '城市级' },
    { name: '全国县级', file: 'data/县.geojson', nameKey: '县', label: '区县级' },
    { name: '昆明市区县', file: 'data/昆明市.geojson', nameKey: '县', label: '区县级' },
];

export const ROAM = {
    active: false,
    mode: null,
    listener: null,
    speed: 0.8,
    waypoints: [],
    waypointMode: false,
    waypointIndex: 0,
    waypointEntities: [],
};

export const vectorMapCache = {};

// =========================== 工具函数 ===========================
export function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 3000);
    setTimeout(() => el.remove(), 3400);
}

export function formatNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

export function generateId() {
    return 'ds-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

export function arrayMin(arr) {
    if (!arr || !arr.length) return Infinity;
    let m = arr[0];
    for (let i = 1; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
}

export function arrayMax(arr) {
    if (!arr || !arr.length) return -Infinity;
    let m = arr[0];
    for (let i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
}

export function isValidLngLat(lng, lat) {
    return typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180 &&
        typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidDeformation(v) {
    return typeof v === 'number' && isFinite(v);
}

export function updateLoadedFilesUI(module) {
    const suffix = module === 'analysis' ? 'Analysis' : module === 'roam' ? 'Roam' : '';
    const panel = document.getElementById('loadedFilesPanel' + suffix);
    const list = document.getElementById('loadedFilesList' + suffix);
    if (!panel || !list) return;
    if (STATE.loadedFileNames.length === 0) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = 'block';
    list.innerHTML = STATE.loadedFileNames.map(name => `<div class="loaded-file-item">${name}</div>`).join('');
}
