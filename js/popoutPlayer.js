/* ═══════════════════════════════════════════
   SimpleReplay — Popout Player
   Standalone video window driven by the main app via BroadcastChannel.
   ═══════════════════════════════════════════ */

import { VideoPlayer } from './VideoPlayer.js';

const CHANNEL_NAME = 'simplereplay-popout';
const channel = new BroadcastChannel(CHANNEL_NAME);

const player = new VideoPlayer('popout-player');
player.setPlaybackActivityCallback((ev) => {
    if (!ev || !ev.action) return;
    try {
        channel.postMessage({ type: 'mirror', payload: ev });
    } catch (_) { /* noop */ }
});
const emptyEl = document.getElementById('popout-empty');
const statusEl = document.getElementById('popout-status');

let _currentObjectUrl = null;
let _hasMedia = false;
let _statusTimer = null;
/** Evita eco cuando el volumen viene de la app principal */
let _lastVolMirror = { v: -1, m: null };

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

async function loadMedia(payload) {
    if (!payload) return;

    if (_currentObjectUrl) {
        try { URL.revokeObjectURL(_currentObjectUrl); } catch (_) { /* noop */ }
        _currentObjectUrl = null;
    }

    if (payload.kind === 'youtube' && payload.id) {
        await player.loadVideo({ type: 'youtube', id: payload.id });
        _hasMedia = true;
        _snapVolFromPlayer();
        hideEmpty();
        showStatus('YouTube cargado');
        return;
    }

    if (payload.kind === 'local' && payload.file instanceof Blob) {
        const url = URL.createObjectURL(payload.file);
        _currentObjectUrl = url;
        await player.loadVideo({ type: 'local', url });
        _hasMedia = true;
        _snapVolFromPlayer();
        hideEmpty();
        showStatus('Video local cargado');
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
        try { player.seekTo(payload.currentTime); } catch (_) { /* noop */ }
    }
    if (payload.isPlaying) {
        try { player.play(); } catch (_) { /* noop */ }
    } else {
        try { player.pause(); } catch (_) { /* noop */ }
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

channel.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    await player.playbackSilenced(async () => {
        switch (msg.type) {
            case 'sync':
                await applySync(msg.payload);
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
    });
});

window.addEventListener('beforeunload', () => {
    try { channel.postMessage({ type: 'closing' }); } catch (_) { /* noop */ }
    if (_currentObjectUrl) {
        try { URL.revokeObjectURL(_currentObjectUrl); } catch (_) { /* noop */ }
    }
});

channel.postMessage({ type: 'ready' });
showStatus('Conectado a SimpleReplay');

setInterval(() => {
    if (!_hasMedia) return;
    let v;
    let m;
    try {
        v = player.getVolume();
        m = player.isMuted();
    } catch (_) {
        return;
    }
    if (v === _lastVolMirror.v && m === _lastVolMirror.m) return;
    _lastVolMirror = { v, m };
    mirrorVolumeToMain();
}, 800);
