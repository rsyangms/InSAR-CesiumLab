// =========================== UI 面板管理 ===========================
import { MODULE_TITLES } from '../core/state.js';
import { updateDatasetList } from '../data/datasetManager.js';
import { updateLoadedFilesUI } from '../core/state.js';

export function initPanelUI() {
    // 模块切换
    document.querySelectorAll('.module-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.module-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const mod = btn.dataset.module;
            const info = MODULE_TITLES[mod] || { icon: '', title: mod };
            document.getElementById('panelTitle').innerHTML = `<span class="module-icon">${info.icon}</span>${info.title}`;
            document.querySelectorAll('.module-content').forEach(c => c.classList.remove('active'));
            const target = document.getElementById('module-' + mod);
            if (target) target.classList.add('active');
            document.getElementById('leftPanel').classList.add('open');
            updateDatasetList();
            updateLoadedFilesUI(mod === 'analysis' ? 'analysis' : mod === 'roam' ? 'roam' : '');
        });
    });

    // 关闭面板
    document.getElementById('closePanelBtn').addEventListener('click', () => {
        document.getElementById('leftPanel').classList.remove('open');
    });

    // 折叠面板
    document.querySelectorAll('.accordion-header').forEach(h => {
        h.addEventListener('click', () => {
            const b = document.getElementById(h.dataset.target);
            const a = h.querySelector('.arrow');
            if (b) { b.classList.toggle('open'); if (a) a.classList.toggle('open'); }
        });
    });
}
