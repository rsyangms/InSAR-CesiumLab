// =========================== 颜色方案 ===========================
import { STATE } from '../core/state.js';

function lerpColor(t, stops) {
    // stops: [{t, r, g, b}, ...] sorted by t
    if (t <= 0) return stops[0];
    if (t >= 1) return stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        if (t >= a.t && t <= b.t) {
            const p = (t - a.t) / (b.t - a.t);
            return {
                r: a.r + (b.r - a.r) * p,
                g: a.g + (b.g - a.g) * p,
                b: a.b + (b.b - a.b) * p,
            };
        }
    }
    return stops[stops.length - 1];
}

export function getColorByScheme(value, scheme) {
    const t = Math.max(0, Math.min(1, value));
    let r = 100, g = 150, b = 200;

    const schemes = {
        // 7-stop blue -> white -> red (matches .color-ramp-opt[data-scheme="blue-white-red"])
        'blue-white-red': [
            { t: 0, r: 30, g: 58, b: 138 },
            { t: 1 / 6, r: 59, g: 130, b: 246 },
            { t: 2 / 6, r: 147, g: 197, b: 253 },
            { t: 3 / 6, r: 255, g: 255, b: 255 },
            { t: 4 / 6, r: 252, g: 211, b: 77 },
            { t: 5 / 6, r: 249, g: 115, b: 22 },
            { t: 1, r: 220, g: 38, b: 38 },
        ],
        // 6-stop blue -> green -> red
        'blue-green-red': [
            { t: 0, r: 30, g: 58, b: 138 },
            { t: 0.2, r: 34, g: 211, b: 238 },
            { t: 0.4, r: 134, g: 239, b: 172 },
            { t: 0.6, r: 254, g: 240, b: 138 },
            { t: 0.8, r: 249, g: 115, b: 22 },
            { t: 1, r: 220, g: 38, b: 38 },
        ],
        // viridis
        'viridis': [
            { t: 0, r: 68, g: 1, b: 84 },
            { t: 0.25, r: 59, g: 82, b: 139 },
            { t: 0.5, r: 33, g: 145, b: 140 },
            { t: 0.75, r: 94, g: 201, b: 98 },
            { t: 1, r: 253, g: 231, b: 37 },
        ],
        // thermal
        'thermal': [
            { t: 0, r: 13, g: 8, b: 135 },
            { t: 0.25, r: 84, g: 9, b: 140 },
            { t: 0.5, r: 183, g: 55, b: 121 },
            { t: 0.75, r: 238, g: 129, b: 58 },
            { t: 1, r: 240, g: 249, b: 33 },
        ],
        // gray
        'gray': [
            { t: 0, r: 17, g: 17, b: 17 },
            { t: 0.25, r: 51, g: 51, b: 51 },
            { t: 0.5, r: 102, g: 102, b: 102 },
            { t: 0.75, r: 204, g: 204, b: 204 },
            { t: 1, r: 255, g: 255, b: 255 },
        ],
        // topo (green -> yellow -> brown -> red)
        'topo': [
            { t: 0, r: 0, g: 104, b: 55 },
            { t: 1 / 7, r: 26, g: 152, b: 80 },
            { t: 2 / 7, r: 102, g: 189, b: 99 },
            { t: 3 / 7, r: 166, g: 217, b: 106 },
            { t: 4 / 7, r: 254, g: 224, b: 139 },
            { t: 5 / 7, r: 253, g: 174, b: 97 },
            { t: 6 / 7, r: 244, g: 109, b: 67 },
            { t: 1, r: 165, g: 0, b: 38 },
        ],
    };

    const stops = schemes[scheme];
    if (stops) {
        const c = lerpColor(t, stops);
        r = c.r;
        g = c.g;
        b = c.b;
    } else {
        r = 100; g = 150; b = 200;
    }

    return new Cesium.Color(
        Math.max(0, Math.min(255, r || 0)) / 255,
        Math.max(0, Math.min(255, g || 0)) / 255,
        Math.max(0, Math.min(255, b || 0)) / 255, 1.0
    );
}

export function deformationToColor(value, min, max) {
    const range = max - min || 1;
    return getColorByScheme((value - min) / range, STATE.colorScheme);
}

export function updateColorRampPreview() {
    const gradientStr = _buildGradientStr();
    const previewEl = document.getElementById('colorRampPreview');
    if (previewEl) previewEl.style.background = gradientStr;
    // 同步底部状态栏色带
    const barEl = document.getElementById('colorRampGradient');
    if (barEl) barEl.style.background = gradientStr;
    // 同步速率范围色带 (visControls 中的 #colorBarGradient)
    const visBarEl = document.getElementById('colorBarGradient');
    if (visBarEl) visBarEl.style.background = gradientStr;
    // 同步沉降/抬升两端色块（底部状态栏 + 面板色标条，随色标方案实时变化）
    const c0 = getColorByScheme(0, STATE.colorScheme).toCssHexString();
    const c1 = getColorByScheme(1, STATE.colorScheme).toCssHexString();
    for (const id of ['crSwatchMin', 'colorBarSwatchMin']) {
        const el = document.getElementById(id);
        if (el) el.style.background = c0;
    }
    for (const id of ['crSwatchMax', 'colorBarSwatchMax']) {
        const el = document.getElementById(id);
        if (el) el.style.background = c1;
    }
}

function _buildGradientStr() {
    const stops = [];
    for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const color = getColorByScheme(t, STATE.colorScheme);
        const hex = color.toCssHexString();
        stops.push(`${hex} ${(t * 100).toFixed(1)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
}
