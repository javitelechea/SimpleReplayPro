/* ═══════════════════════════════════════════
   SimpleReplay — Popout Player
   Standalone video window driven by the main app via BroadcastChannel.
   ═══════════════════════════════════════════ */

import { VideoPlayer } from './VideoPlayer.js';
import {
    consumeStagedPopoutDescriptor,
    peekStagedPopoutDescriptor,
    readLocalFileForPopout,
} from './popoutMediaShare.js';
import {
    paintLinePreview,
    paintPenPreview,
    paintStrokeList,
} from './drawingMirror.js';

const CHANNEL_NAME = 'simplereplay-popout';
const RAIL_COLLAPSED_KEY = 'fullscreenClipRailCollapsed';
const channel = new BroadcastChannel(CHANNEL_NAME);

const player = new VideoPlayer('popout-player', { youtubeShowControls: false, localNativeControls: true });
player.setPlaybackActivityCallback((ev) => {
    if (!ev || !ev.action) return;
    try {
        channel.postMessage({ type: 'mirror', payload: ev });
    } catch (_) { /* noop */ }
});
const emptyEl = document.getElementById('popout-empty');
const statusEl = document.getElementById('popout-status');
const clipRailEl = document.getElementById('popout-clip-rail');
const clipRailToggle = document.getElementById('popout-clip-rail-toggle');
const drawingCanvas = document.getElementById('popout-drawing-canvas');
const drawingCtx = drawingCanvas ? drawingCanvas.getContext('2d') : null;

let _currentObjectUrl = null;
let _mirrorStrokes = [];
let _mirrorPreview = null;
let _hasMedia = false;
let _statusTimer = null;
let _currentMediaKey = '';
/** Evita eco cuando el volumen viene de la app principal */
let _lastVolMirror = { v: -1, m: null };

function _isBlobLikeFile(obj) {
    return !!(
        obj &&
        typeof obj === 'object' &&
        typeof obj.size === 'number' &&
        (typeof obj.arrayBuffer === 'function' || typeof obj.stream === 'function')
    );
}

function _localFileFromPayload(payload) {
    if (!payload || payload.kind !== 'local') return null;
    if (_isBlobLikeFile(payload.file)) return payload.file;
    if (payload.buffer instanceof ArrayBuffer && payload.buffer.byteLength > 0) {
        return new File(
            [payload.buffer],
            payload.name || 'video.mp4',
            { type: payload.type || 'video/mp4' }
        );
    }
    return null;
}

function _mediaKey(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (payload.kind === 'youtube' && payload.id) return `yt:${payload.id}`;
    if (payload.kind === 'local-opfs' && payload.shareId) {
        return `opfs:${payload.shareId}:${payload.name || ''}:${payload.size || 0}`;
    }
    if (payload.kind === 'local') {
        if (payload.buffer instanceof ArrayBuffer) {
            return `local:buf:${payload.buffer.byteLength}:${payload.name || ''}:${payload.type || ''}`;
        }
        if (_isBlobLikeFile(payload.file)) {
            const f = payload.file;
            const name = typeof f.name === 'string' ? f.name : '';
            const size = typeof f.size === 'number' ? f.size : -1;
            const lm = typeof f.lastModified === 'number' ? f.lastModified : -1;
            const type = typeof f.type === 'string' ? f.type : '';
            return `local:${name}:${size}:${lm}:${type}`;
        }
    }
    return '';
}

function _snapVolFromPlayer() {
    try {
        _lastVolMirror = { v: player.getVolume(), m: player.isMuted() };
    } catch (_) { /* noop */ }
}

function mirrorVolumeToMain() {
    if (!_hasMedia) return;
    try {
        channel.postMessage({
            type: 'mirror',
            payload: {
                action: 'volume',
                volume: player.getVolume(),
                muted: player.isMuted()
            }
        });
    } catch (_) { /* noop */ }
}

function showStatus(text, ms = 1200) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.add('show');
    if (_statusTimer) clearTimeout(_statusTimer);
    _statusTimer = setTimeout(() => statusEl.classList.remove('show'), ms);
}

function hideEmpty() {
    if (emptyEl) emptyEl.classList.add('hidden');
}

function resizeDrawingCanvas() {
    if (!drawingCanvas) return;
    const stage = document.getElementById('popout-stage');
    const rect = (stage || drawingCanvas.parentElement)?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return;
    drawingCanvas.width = Math.floor(rect.width);
    drawingCanvas.height = Math.floor(rect.height);
    redrawMirrorDrawing();
}

function redrawMirrorDrawing() {
    if (!drawingCtx || !drawingCanvas) return;
    const w = drawingCanvas.width || 1;
    const h = drawingCanvas.height || 1;
    drawingCtx.clearRect(0, 0, w, h);
    paintStrokeList(drawingCtx, _mirrorStrokes, w, h, true);
    if (_mirrorPreview?.kind === 'line') {
        paintLinePreview(drawingCtx, _mirrorPreview, w, h);
    } else if (_mirrorPreview?.kind === 'pen') {
        paintPenPreview(drawingCtx, _mirrorPreview.stroke, w, h);
    }
}

function applyMirrorDrawing(payload) {
    if (!drawingCanvas || !drawingCtx) return;
    if (!payload || !payload.active) {
        _mirrorStrokes = [];
        _mirrorPreview = null;
        drawingCanvas.classList.remove('active');
        drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
        return;
    }
    _mirrorStrokes = Array.isArray(payload.strokes) ? payload.strokes : [];
    _mirrorPreview = payload.preview || null;
    resizeDrawingCanvas();
    drawingCanvas.classList.add('active');
    redrawMirrorDrawing();
}

function notifyOpenerHasMedia() {
    try {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'sr-popout-has-media' }, window.location.origin);
        }
    } catch (_) { /* noop */ }
}

async function loadMedia(payload) {
    if (!payload) return;
    const key = _mediaKey(payload);
    if (key && key === _currentMediaKey) return;

    if (_currentObjectUrl) {
        try { URL.revokeObjectURL(_currentObjectUrl); } catch (_) { /* noop */ }
        _currentObjectUrl = null;
    }

    if (payload.kind === 'local-opfs') {
        showStatus('Cargando video local…', 8000);
        try {
            const file = await readLocalFileForPopout(payload);
            const url = URL.createObjectURL(file);
            _currentObjectUrl = url;
            await player.loadVideo({ type: 'local', url });
            _hasMedia = true;
            _currentMediaKey = key;
            _snapVolFromPlayer();
            hideEmpty();
            showStatus('Video local cargado');
            notifyOpenerHasMedia();
        } catch (e) {
            console.warn('[Popout] OPFS read:', e?.message || e);
            showStatus('No se pudo cargar el video (OPFS)', 4000);
        }
        return;
    }

    if (payload.kind === 'youtube' && payload.id) {
        await player.loadVideo({ type: 'youtube', id: payload.id });
        _hasMedia = true;
        _currentMediaKey = key;
        _snapVolFromPlayer();
        hideEmpty();
        showStatus('YouTube cargado');
        notifyOpenerHasMedia();
        return;
    }

    if (payload.kind === 'local') {
        const file = _localFileFromPayload(payload);
        if (!file) {
            showStatus('Video local: datos no recibidos', 2500);
            return;
        }
        const url = URL.createObjectURL(file);
        _currentObjectUrl = url;
        await player.loadVideo({ type: 'local', url });
        _hasMedia = true;
        _currentMediaKey = key;
        _snapVolFromPlayer();
        hideEmpty();
        showStatus('Video local cargado');
        notifyOpenerHasMedia();
        return;
    }
}

async function applySync(payload) {
    if (!payload) return;
    if (payload.media) {
        await loadMedia(payload.media);
    }
    if (typeof payload.rate === 'number') {
        try { player.setPlaybackRate(payload.rate); } catch (_) { /* noop */ }
    }
    if (typeof payload.currentTime === 'number') {
        try {
            const current = player.getCurrentTime();
            if (Math.abs(current - payload.currentTime) > 0.5) {
                player.seekTo(payload.currentTime);
            }
        } catch (_) { /* noop */ }
    }
    if (payload.isPlaying === true) {
        try {
            if (!player.isPlayingNow || !player.isPlayingNow()) player.play();
        } catch (_) { /* noop */ }
    } else if (payload.isPlaying === false) {
        try {
            if (player.isPlayingNow && player.isPlayingNow()) player.pause();
            else if (player.isPlaying) player.pause();
        } catch (_) { /* noop */ }
    }
    if (typeof payload.volume === 'number' || typeof payload.muted === 'boolean') {
        if (payload.muted === true) player.mute();
        else if (payload.muted === false) player.unMute();
        if (typeof payload.volume === 'number') {
            player.setVolume(payload.volume);
            if (payload.volume > 0 && player.isMuted()) player.unMute();
        }
    }
    _snapVolFromPlayer();
}

function applyPopoutClipRail(payload) {
    if (!clipRailEl) return;
    if (!payload || !payload.show) {
        clipRailEl.classList.remove('is-visible');
        clipRailEl.hidden = true;
        return;
    }
    clipRailEl.hidden = false;
    clipRailEl.classList.add('is-visible');
    clipRailEl.classList.toggle('is-collapsed', !!payload.collapsed);

    const prevBtn = clipRailEl.querySelector('[data-rail-dir="prev"]');
    const nextBtn = clipRailEl.querySelector('[data-rail-dir="next"]');
    const currentRow = clipRailEl.querySelector('.fullscreen-clip-rail__row--current');
    const countEl = clipRailEl.querySelector('.fullscreen-clip-rail__count');

    if (prevBtn) {
        prevBtn.textContent = payload.prevLine || 'Anterior — —';
        prevBtn.disabled = !!payload.prevDisabled;
    }
    if (currentRow) {
        currentRow.textContent = payload.currentLine || 'Actual — —';
    }
    if (nextBtn) {
        nextBtn.textContent = payload.nextLine || 'Siguiente — —';
        nextBtn.disabled = !!payload.nextDisabled;
    }
    if (countEl) countEl.textContent = payload.count || '';

    if (clipRailToggle) {
        clipRailToggle.setAttribute('aria-expanded', payload.collapsed ? 'false' : 'true');
    }
}

function wirePopoutClipRail() {
    if (!clipRailEl || clipRailEl.dataset.wired === '1') return;
    clipRailEl.dataset.wired = '1';

    clipRailToggle?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const collapsed = !clipRailEl.classList.contains('is-collapsed');
        clipRailEl.classList.toggle('is-collapsed', collapsed);
        localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
        if (clipRailToggle) {
            clipRailToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
    });

    clipRailEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target.closest('#popout-clip-rail-toggle')) return;
        const btn = ev.target.closest('[data-rail-dir]');
        if (!btn || btn.disabled) return;
        try {
            channel.postMessage({ type: 'railNavigate', direction: btn.dataset.railDir });
        } catch (_) { /* noop */ }
    });
}

function requestMediaFromOpener(timeoutMs = 15000) {
    if (!window.opener || window.opener.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            window.removeEventListener('message', onMsg);
            resolve(null);
        }, timeoutMs);
        const onMsg = (ev) => {
            if (ev.source !== window.opener) return;
            if (ev.origin !== window.location.origin) return;
            if (ev.data?.type !== 'sr-popout-media') return;
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            resolve(ev.data.payload || null);
        };
        window.addEventListener('message', onMsg);
        try {
            window.opener.postMessage({ type: 'sr-popout-request-media' }, window.location.origin);
        } catch (_) {
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            resolve(null);
        }
    });
}

channel.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'rail') {
        applyPopoutClipRail(msg.payload);
        return;
    }
    if (msg.type === 'drawing') {
        applyMirrorDrawing(msg.payload);
        return;
    }
    try {
        switch (msg.type) {
            case 'sync':
                await player.playbackSilenced(() => applySync(msg.payload));
                break;
            case 'load':
                await loadMedia(msg.payload);
                break;
            case 'play':
                if (_hasMedia) player.play();
                break;
            case 'pause':
                if (_hasMedia) player.pause();
                break;
            case 'seek':
                if (_hasMedia && msg.payload && typeof msg.payload.seconds === 'number') {
                    player.seekTo(msg.payload.seconds);
                }
                break;
            case 'speed':
                if (_hasMedia && msg.payload && typeof msg.payload.rate === 'number') {
                    player.setPlaybackRate(msg.payload.rate);
                }
                break;
            case 'volume':
                if (_hasMedia && msg.payload) {
                    const p = msg.payload;
                    if (p.muted === true) player.mute();
                    else if (p.muted === false) player.unMute();
                    if (typeof p.volume === 'number') {
                        player.setVolume(p.volume);
                        if (p.volume > 0 && player.isMuted()) player.unMute();
                    }
                    _snapVolFromPlayer();
                }
                break;
            case 'ping':
                channel.postMessage({ type: 'pong' });
                break;
            case 'close':
                window.close();
                break;
            default:
                break;
        }
    } catch (err) {
        console.error('[Popout]', err);
        showStatus(err?.message || 'Error en el player', 5000);
    }
});

window.addEventListener('beforeunload', () => {
    try { channel.postMessage({ type: 'closing' }); } catch (_) { /* noop */ }
    if (_currentObjectUrl) {
        try { URL.revokeObjectURL(_currentObjectUrl); } catch (_) { /* noop */ }
    }
});

window.addEventListener('message', (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.data?.type !== 'sr-popout-media' || !ev.data.payload) return;
    void loadMedia(ev.data.payload);
});

async function bootstrap() {
    wirePopoutClipRail();

    let staged = peekStagedPopoutDescriptor();
    if (!staged) {
        staged = await requestMediaFromOpener();
    }
    if (staged) {
        showStatus('Cargando video…', 20000);
        try {
            await loadMedia(staged);
            if (_hasMedia) consumeStagedPopoutDescriptor();
        } catch (e) {
            console.error('[Popout] bootstrap load:', e);
            showStatus(e?.message || 'No se pudo cargar el video', 6000);
        }
    }

    channel.postMessage({ type: 'ready' });
    try {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'sr-popout-ready' }, window.location.origin);
        }
    } catch (_) { /* noop */ }
    showStatus(_hasMedia ? 'Conectado' : 'Conectado — sin video aún');
}

void bootstrap();

window.addEventListener('resize', () => {
    if (drawingCanvas?.classList.contains('active')) resizeDrawingCanvas();
});

setInterval(() => {
    if (!_hasMedia) return;
    let v;
    let m;
    let t;
    try {
        v = player.getVolume();
        m = player.isMuted();
        t = player.getCurrentTime();
    } catch (_) {
        return;
    }
    const volChanged = v !== _lastVolMirror.v || m !== _lastVolMirror.m;
    if (volChanged) {
        _lastVolMirror = { v, m };
        mirrorVolumeToMain();
    }
    if (typeof t === 'number' && Number.isFinite(t)) {
        try {
            channel.postMessage({ type: 'mirror', payload: { action: 'time', time: t } });
        } catch (_) { /* noop */ }
    }
}, 250);
