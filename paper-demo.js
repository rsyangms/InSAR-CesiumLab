/**
 * ========================================================================
 * InSAR Cesium可视化平台 - 论文代码演示模块
 * 集成关键代码：后端服务 + 项目配置 + 前端源代码
 * ========================================================================
 */

// ============================================================================
// [项目配置 - package.json]
// 定义项目元数据、脚本命令和依赖关系
// ============================================================================
const PROJECT_CONFIG = {
  name: "insar-cesium-visualization-platform",
  version: "0.1.0",
  description: "Local backend for the InSAR Cesium visualization platform.",
  scripts: {
    start: "node server.js",      // 生产环境启动
    dev: "node server.js"         // 开发环境启动
  },
  engines: { node: ">=18" },
  dependencies: {
    cesium: "latest",             // 地球可视化库
    express: "latest"             // Node.js服务框架
  }
};

// ============================================================================
// [后端服务 - server.js 核心模块]
// HTTP服务器，处理文件上传、数据解析、瓦片生成等后端逻辑
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

// 后端配置参数
const SERVER_CONFIG = {
  HOST: process.env.HOST || '127.0.0.1',
  PORT: Number(process.env.PORT || 5177),
  MAX_BODY_MB: Number(process.env.MAX_BODY_MB || 512),
  TILESETS_DIR: path.join(__dirname, '.tilesets')
};

// 后端MIME类型映射
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.pnts': 'application/octet-stream',
  '.png': 'image/png'
};

/**
 * [后端服务] HTTP请求处理函数
 * 处理上传数据、返回静态资源、生成瓦片等
 */
function handleRequest(req, res) {
  setCorsHeaders(res);
  
  if (req.method === 'POST' && req.url === '/api/upload') {
    handleDataUpload(req, res);
  } else if (req.method === 'POST' && req.url === '/api/parse') {
    handleDataParsing(req, res);
  } else if (req.method === 'GET') {
    serveStaticFile(req, res);
  } else {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  }
}

/**
 * [后端服务] 设置CORS跨域头
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * [后端服务] 处理数据上传
 */
async function handleDataUpload(req, res) {
  try {
    const fileData = await readRequestBody(req);
    const parsed = await parseCSVorGeoJSON(fileData);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      records: parsed.length,
      stats: computeBasicStats(parsed)
    }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * [后端服务] 解析CSV或GeoJSON文件
 */
async function parseCSVorGeoJSON(data) {
  if (data.includes('"type":"FeatureCollection"')) {
    return JSON.parse(data).features.map(f => f.properties);
  } else {
    // CSV解析逻辑
    const lines = data.trim().split('\n');
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
      const values = line.split(',');
      return headers.reduce((obj, h, i) => ({...obj, [h]: values[i]}), {});
    });
  }
}

/**
 * [后端服务] 计算基础统计信息
 */
function computeBasicStats(data) {
  return {
    total: data.length,
    fields: data.length ? Object.keys(data[0]) : []
  };
}

/**
 * [后端服务] 读取请求体数据
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * [后端服务] 提供静态文件服务
 */
function serveStaticFile(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * [后端服务] 启动HTTP服务器
 */
const server = http.createServer(handleRequest);
server.listen(SERVER_CONFIG.PORT, SERVER_CONFIG.HOST, () => {
  console.log(`[服务器启动] http://${SERVER_CONFIG.HOST}:${SERVER_CONFIG.PORT}`);
});

// ============================================================================
// [前端源代码 - 全局状态管理 state.js]
// 集中管理应用所有全局状态数据
// ============================================================================
const STATE = {
  // 数据集管理
  datasets: [],
  currentFile: null,
  activeDatasetId: null,
  isLoaded: false,
  
  // 可视化参数
  pointSize: 4,
  pointOpacity: 0.9,
  colorScheme: 'topo',
  colorMin: null,
  colorMax: null,
  exaggeration: 1.0,
  heightOffset: 0,
  
  // 时间序列数据
  timeData: [],
  timeIndex: 0,
  timePlaying: false,
  
  // 异常检测结果
  anomalyPoints: [],
  anomalyIndex: null,
  
  // 边界数据
  boundaryPolygons: [],
  boundaryCoordinates: null,
  _boundaryFullCoordinates: null,
  
  // 摄像机和交互
  cameraLevel: 0,
  pickMode: false,
  pickedPoint: null
};

// LOD（层级细节）配置 - 性能优化关键
const LOD_CONFIG = [
  { level: 0, maxDist: Infinity, minDist: 100000, label: '极远', maxVertices: 8 },
  { level: 1, maxDist: 100000, minDist: 50000, label: '远', maxVertices: 25 },
  { level: 2, maxDist: 50000, minDist: 10000, label: '中', maxVertices: 80 },
  { level: 3, maxDist: 10000, minDist: 0, label: '近', maxVertices: Infinity }
];

// ============================================================================
// [前端源代码 - Cesium 3D视图初始化 viewer.js]
// 初始化Cesium地球引擎和场景配置
// ============================================================================

const CESIUM_CONFIG = {
  ION_ACCESS_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  VIEWER_OPTIONS: {
    baseLayerPicker: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    navigationHelpButton: false,
    geocoder: false,
    infoBox: false,
    shadows: false,
    contextOptions: {
      webgl: {
        alpha: false,
        antialias: true,
        powerPreference: 'high-performance'
      }
    }
  }
};

/**
 * [前端模块] 初始化Cesium 3D视图
 */
function initViewer() {
  if (Cesium?.Ion) {
    Cesium.Ion.defaultAccessToken = CESIUM_CONFIG.ION_ACCESS_TOKEN;
  }
  
  try {
    const viewer = new Cesium.Viewer('cesiumContainer', {
      terrain: Cesium.Terrain.fromWorldTerrain({
        requestWaterMask: false,
        requestVertexNormals: false
      }),
      ...CESIUM_CONFIG.VIEWER_OPTIONS
    });
    
    // 摄像机变动事件监听
    if (viewer?.camera?.changed) {
      viewer.camera.changed.addEventListener(() => {
        renderBoundary();
        updateVisualization();
      });
    }
    
    return viewer;
  } catch (error) {
    console.error('[Cesium初始化失败]', error);
    return null;
  }
}

// ============================================================================
// [前端源代码 - 数据管理模块 datasetManager.js]
// 处理数据集添加、删除、切换、时间序列检测等
// ============================================================================

/**
 * [前端模块] 添加新数据集到应用
 */
function addDataset(name, data, stats) {
  // 构建体素LOD结构用于性能优化
  const voxelLevels = buildVoxelLOD(data);
  
  const dataset = {
    id: 'ds-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    name: name || '未命名',
    type: 'custom',
    visible: true,
    data: data,
    voxelLevels: voxelLevels,
    stats: stats || { total: data.length, valid: data.length },
    createdAt: new Date().toISOString()
  };
  
  STATE.datasets.push(dataset);
  STATE.activeDatasetId = dataset.id;
  STATE.isLoaded = true;
  
  // 检测时间维度
  detectTimeData();
  
  // 刷新可视化
  updateVisualization();
  updateDatasetList();
  
  return dataset;
}

/**
 * [前端模块] 构建体素LOD金字塔结构
 * 用于多尺度点云渲染优化
 */
function buildVoxelLOD(data) {
  const lod = { level0: [], level1: [], level2: [], level3: [] };
  
  // 简化的LOD分组：根据数据密度和距离聚合
  for (let i = 0; i < data.length; i++) {
    const point = data[i];
    const level = i % 4; // 简化示例
    lod[`level${level}`].push(point);
  }
  
  return lod;
}

/**
 * [前端模块] 移除指定数据集
 */
function removeDataset(id) {
  STATE.datasets = STATE.datasets.filter(d => d.id !== id);
  if (STATE.activeDatasetId === id) {
    STATE.activeDatasetId = STATE.datasets.length ? STATE.datasets[0].id : null;
  }
  if (!STATE.datasets.length) STATE.isLoaded = false;
  
  detectTimeData();
  updateVisualization();
}

/**
 * [前端模块] 检测时间序列维度
 */
function detectTimeData() {
  const allYears = new Set();
  
  for (const ds of STATE.datasets) {
    if (!ds.data) continue;
    for (const point of ds.data) {
      if (point.year != null) {
        allYears.add(String(point.year));
      }
    }
  }
  
  STATE.timeData = Array.from(allYears).sort();
  STATE.timeIndex = 0;
}

// ============================================================================
// [前端源代码 - 渲染模块 pointCloud.js]
// 点云渲染、高度模型、颜色映射等可视化处理
// ============================================================================

/**
 * [前端模块] 更新点云可视化
 */
function updateVisualization() {
  if (!STATE.isLoaded) return;
  
  // 清除旧的点云
  clearPointCloud();
  
  // 根据活跃数据集和LOD级别渲染
  const activeDataset = STATE.datasets.find(d => d.id === STATE.activeDatasetId);
  if (!activeDataset) return;
  
  // 应用颜色映射
  const coloredPoints = applyColorMap(activeDataset.data);
  
  // 应用高度模型
  const elevatedPoints = applyHeightModel(coloredPoints);
  
  // 根据摄像机LOD渲染
  const lodLevel = calculateLODLevel();
  renderPointsAtLOD(elevatedPoints, lodLevel);
}

/**
 * [前端模块] 应用颜色映射
 */
function applyColorMap(data) {
  const minVal = STATE.colorMin ?? Math.min(...data.map(p => p.value));
  const maxVal = STATE.colorMax ?? Math.max(...data.map(p => p.value));
  const range = maxVal - minVal;
  
  return data.map(point => {
    const normalized = (point.value - minVal) / range;
    // 使用选定的色彩方案（如'topo', 'rainbow'等）
    const color = getColorFromScheme(STATE.colorScheme, normalized);
    return { ...point, color };
  });
}

/**
 * [前端模块] 应用高度模型
 */
function applyHeightModel(data) {
  const exag = STATE.exaggeration;
  const offset = STATE.heightOffset;
  
  return data.map(point => ({
    ...point,
    height: (point.height || 0) * exag + offset
  }));
}

/**
 * [前端模块] 根据LOD级别计算应呈现的点
 */
function calculateLODLevel() {
  const cameraHeight = 1000; // 简化示例
  for (let i = 0; i < LOD_CONFIG.length; i++) {
    if (cameraHeight >= LOD_CONFIG[i].minDist && cameraHeight <= LOD_CONFIG[i].maxDist) {
      return i;
    }
  }
  return 0;
}

/**
 * [前端模块] 在指定LOD级别渲染点云
 */
function renderPointsAtLOD(points, lodLevel) {
  const activeDataset = STATE.datasets.find(d => d.id === STATE.activeDatasetId);
  if (!activeDataset) return;
  
  // 从相应LOD层级中取点
  const lodPoints = activeDataset.voxelLevels[`level${lodLevel}`] || [];
  
  // 使用Cesium Primitive API渲染
  const positions = [];
  const colors = [];
  
  for (const point of lodPoints) {
    positions.push(point.lng, point.lat, point.height);
    const color = point.color || { r: 255, g: 100, b: 50, a: 255 };
    colors.push(color.r, color.g, color.b, color.a);
  }
  
  // 创建点云Primitive
  if (positions.length > 0) {
    renderPointPrimitive(positions, colors);
  }
}

/**
 * [前端模块] 渲染点Primitive（简化示例）
 */
function renderPointPrimitive(positions, colors) {
  // 实际实现中调用Cesium API
  console.log(`[点云渲染] ${positions.length / 3} 个点，LOD优化生效`);
}

/**
 * [前端模块] 清除旧点云
 */
function clearPointCloud() {
  // 实际实现中调用Cesium API移除所有点
  console.log('[清除点云]');
}

/**
 * [前端模块] 获取色彩映射
 */
function getColorFromScheme(scheme, normalized) {
  const schemes = {
    topo: { r: 50 + normalized * 200, g: 100 + normalized * 100, b: 200 - normalized * 100 },
    rainbow: { r: Math.sin(normalized * Math.PI) * 255, g: Math.sin((normalized + 1/3) * Math.PI) * 255, b: Math.sin((normalized + 2/3) * Math.PI) * 255 }
  };
  return schemes[scheme] || schemes.topo;
}

// ============================================================================
// [前端源代码 - 分析模块 anomaly.js]
// 异常检测和统计分析
// ============================================================================

/**
 * [前端模块] 异常检测 - Z-Score方法
 */
function detectAnomalies(data, threshold = 2.5) {
  const values = data.map(p => p.value);
  const mean = values.reduce((a, b) => a + b) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2)) / values.length;
  const stdDev = Math.sqrt(variance);
  
  STATE.anomalyPoints = data.filter(p => {
    const zScore = Math.abs((p.value - mean) / stdDev);
    return zScore > threshold;
  });
  
  updateAnomalyVisualization();
}

/**
 * [前端模块] 异常点可视化
 */
function updateAnomalyVisualization() {
  console.log(`[异常检测] 发现 ${STATE.anomalyPoints.length} 个异常点`);
  // 在地图上高亮显示异常点
}

/**
 * [前端模块] 区域统计分析
 */
function computeRegionStats(boundary, timeFilter) {
  const filtered = STATE.datasets
    .flatMap(ds => ds.data)
    .filter(p => isPointInBoundary(p, boundary))
    .filter(p => !timeFilter || p.year === timeFilter);
  
  return {
    count: filtered.length,
    mean: filtered.reduce((a, b) => a + b.value, 0) / filtered.length,
    max: Math.max(...filtered.map(p => p.value)),
    min: Math.min(...filtered.map(p => p.value))
  };
}

function isPointInBoundary(point, boundary) {
  // 点在边界内的判断逻辑
  return true; // 简化示例
}

// ============================================================================
// [前端源代码 - 初始化流程 main.js]
// 应用启动入口，串联所有模块初始化
// ============================================================================

/**
 * [前端模块] 应用初始化主函数
 */
function initializeApp() {
  console.log('[应用启动] InSAR可视化平台初始化...');
  
  // 1. 初始化Cesium视图
  const viewer = initViewer();
  if (!viewer) {
    console.error('[致命错误] Cesium视图初始化失败');
    return;
  }
  
  // 2. 初始化UI面板
  initPanelUI();
  
  // 3. 绑定事件处理器
  initEventHandlers();
  
  // 4. 连接后端API
  setupBackendConnection();
  
  // 5. 最终化显示
  document.getElementById('leftPanel')?.classList.add('open');
  updateDatasetList();
  
  console.log('[应用启动完成] 系统就绪，等待数据上传');
}

/**
 * [前端模块] 初始化UI面板
 */
function initPanelUI() {
  // 创建数据管理面板
  const dataPanel = document.createElement('div');
  dataPanel.id = 'datasetList';
  dataPanel.className = 'dataset-list';
  document.body.appendChild(dataPanel);
  
  console.log('[UI初始化] 面板加载完成');
}

/**
 * [前端模块] 绑定事件处理器
 */
function initEventHandlers() {
  // 数据集删除按钮
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('del-btn')) {
      removeDataset(e.target.dataset.id);
    }
  });
  
  // 文件上传处理
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);
  }
  
  console.log('[事件绑定] 完成');
}

/**
 * [前端模块] 处理文件上传
 */
async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    const formData = new FormData();
    formData.append('file', file);
    
    // 上传到后端
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    console.log('[上传完成]', result);
    
    // 解析并添加数据集
    const data = await parseFile(file);
    addDataset(file.name, data, result.stats);
    
  } catch (error) {
    console.error('[上传失败]', error);
  }
}

/**
 * [前端模块] 解析本地文件
 */
async function parseFile(file) {
  const text = await file.text();
  if (file.name.endsWith('.geojson')) {
    const geo = JSON.parse(text);
    return geo.features.map(f => ({ ...f.properties, geometry: f.geometry }));
  } else if (file.name.endsWith('.csv')) {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
      const values = line.split(',');
      return headers.reduce((obj, h, i) => ({...obj, [h]: parseFloat(values[i]) || values[i]}), {});
    });
  }
  return [];
}

/**
 * [后端服务] 连接到后端服务
 */
function setupBackendConnection() {
  const serverUrl = `http://${SERVER_CONFIG.HOST}:${SERVER_CONFIG.PORT}`;
  console.log(`[后端连接] ${serverUrl}`);
  
  // 定期心跳检测
  setInterval(async () => {
    try {
      await fetch(`${serverUrl}/ping`);
      console.log('[后端正常]');
    } catch (error) {
      console.warn('[后端离线]', error.message);
    }
  }, 5000);
}

function updateDatasetList() {
  console.log('[数据集列表更新]', STATE.datasets.length);
}

function renderBoundary() {
  console.log('[边界渲染]');
}

// ============================================================================
// 启动应用
// ============================================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

// 导出接口供外部调用
export { 
  STATE, 
  addDataset, 
  removeDataset, 
  initializeApp,
  detectAnomalies,
  computeRegionStats,
  SERVER_CONFIG,
  PROJECT_CONFIG,
  CESIUM_CONFIG
};
