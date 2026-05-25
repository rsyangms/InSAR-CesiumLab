import { STATE } from '../core/state.js';

export function getTerrainExaggerationValue(value = STATE.terrainExaggeration) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

export function getTerrainExaggerationRelativeHeight() {
    return 0.0;
}

export function getGroundHeight(point) {
    const groundHeight = Number(point?.groundHeight);
    if (Number.isFinite(groundHeight)) return groundHeight;
    return NaN;
}

// =========================== 高程夸张计算 ===========================
export function exaggerateGroundHeight(groundHeight, terrainExaggeration = STATE.terrainExaggeration) {
    const baseHeight = Number(groundHeight) || 0.0;
    const relativeHeight = getTerrainExaggerationRelativeHeight();
    const ex = getTerrainExaggerationValue(terrainExaggeration);
    return (baseHeight - relativeHeight) * ex + relativeHeight;
}

// =========================== 点渲染高度计算 ===========================
export function getPointRenderHeight(point, extraOffset = 0.0, terrainExaggeration = STATE.terrainExaggeration) {
    const groundHeight = getGroundHeight(point);
    // Point height always comes from terrain; deformation is color-only metadata.
    if (!Number.isFinite(groundHeight)) return NaN;
    return exaggerateGroundHeight(groundHeight, terrainExaggeration) + (Number(extraOffset) || 0.0);
}

// =========================== 附加地形元数据 ===========================
export function attachGroundMetadata(point, terrainExaggeration = STATE.terrainExaggeration) {
    const explicitGroundHeight = Number(point?.groundHeight);
    const hasGroundHeight = Number.isFinite(explicitGroundHeight);
    const groundHeight = hasGroundHeight ? explicitGroundHeight : undefined;
    const normalizedTerrainExaggeration = getTerrainExaggerationValue(
        terrainExaggeration ?? point?.terrainExaggeration ?? STATE.terrainExaggeration
    );

    return {
        ...point,
        groundHeight,
        height: Number.isFinite(groundHeight) ? groundHeight : point?.height,
        terrainExaggeration: normalizedTerrainExaggeration,
    };
}
