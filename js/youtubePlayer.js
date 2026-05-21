/* ═══════════════════════════════════════════
   SimpleReplay — YouTube/Local Player Wrapper
   Provides a compatible YTPlayer interface while using VideoPlayer
   + delegación opcional a LiveCaptureFacade (videoSource liveCapture).
   ═══════════════════════════════════════════ */

import { VideoPlayer } from './VideoPlayer.js';
import { AppState } from './state.js';
import { isLiveRecordingActive, snapshotReview } from './livecapture/liveRecordingController.js';

export const YTPlayer = (() => {
    let _videoPlayer = null;
    /** @type {import('./livecapture/LiveCaptureFacade.js').LiveCaptureFacade|null} */
    let _liveFacade = null;
    let _ready = false;
    let _clipEndSec = null;
    let _pollTimer = null;
    let _onReadyCb = null;
    let _clipAutoPaused = false;
    let _lastMedia = null;
    let _commandListener = null;
    let _suppressMirrorEchoUntil = 0;
    let _youtubeNativeControlsEnabled = false;
    let _lastSeekEmitAt = 0;
    let _uiTimeOverride = null;
    /** @type {{ isConnected?: () => boolean, notifySeek?: (s: number) => void, notifyPlay?: () => void, notifyPause?: () => void }|null} */
    let _popoutBridge = null;

    function setPopoutBridge(bridge) {
        _popoutBridge = bridge && typeof bridge === 'object' ? bridge : null;
    }

    function _popoutActive() {
        return !!(_popoutBridge && typeof _popoutBridge.isConnected === 'function' && _popoutBridge.isConnected());
    }

    /** Seek en el motor principal sin reenviar eventos al popout (evita bucles). */
    function _seekEngineSilently(sec) {
        const eng = _engine();
        if (!eng || typeof eng.seekTo !== 'function') return;
        const run = () => {
            try { eng.seekTo(sec); } catch (_) { /* noop */ }
        };
        if (typeof eng.playbackSilenced === 'function') {
            eng.playbackSilenced(run);
        } else {
            run();
        }
    }

    function _buildVideoPlayerInstance() {
        _videoPlayer = new VideoPlayer('youtube-player', {
            youtubeShowControls: _youtubeNativeControlsEnabled,
            localNativeControls: false,
        });
        _videoPlayer.setPlaybackActivityCallback((ev) => {
            if (!ev || !ev.action) return;
            if (ev.action === 'play') _emit('play');
            else if (ev.action === 'pause') _emit('pause');
            else if (ev.action === 'seek' && typeof ev.time === 'number') {
                const now = Date.now();
                if (now - _lastSeekEmitAt < 220) return;
                _lastSeekEmitAt = now;
                _emit('seek', { seconds: ev.time });
            }
        });
    }

    function _usingLiveCapture() {
        return _lastMedia?.kind === 'liveCapture';
    }

    /**
     * Motor activo: captura propia o VideoPlayer (YouTube / archivo local).
     */
    function _engine() {
        if (_usingLiveCapture()) return _liveFacade;
        return _videoPlayer;
    }

    function _leaveLiveCaptureIfNeeded() {
        if (_lastMedia?.kind !== 'liveCapture') return;
        if (_liveFacade) {
            try {
                _liveFacade.unload();
            } catch (_) { /* noop */ }
        }
        _lastMedia = null;
    }

    /** Sale del modo LiveCapture (descarga tracks / superficie). Idempotente. */
    function leaveLiveCapture() {
        _leaveLiveCaptureIfNeeded();
    }

    /** Evita cambiar de fuente mientras MediaRecorder está activo (Fase 3). */
    function _guardNotRecording(actionLabel) {
        if (isLiveRecordingActive()) {
            console.warn(
                `YTPlayer: hay grabación LiveCapture activa — detené antes (${actionLabel}). Consola: __SIMPLE_REPLAY_DEV__.stopCapture()`
            );
            return false;
        }
        return true;
    }

    function _emit(type, payload) {
        if (!_commandListener) return;
        if (Date.now() < _suppressMirrorEchoUntil) return;
        try { _commandListener(type, payload); } catch (_) { /* noop */ }
    }

    function _armMirrorEchoSuppression(ms = 650) {
        _suppressMirrorEchoUntil = Math.max(_suppressMirrorEchoUntil, Date.now() + ms);
    }

    /** Playlist/colección: pausar al fin del clip. Proyecto (lista de clips): seguir para ajustar IN/OUT. */
    function _shouldStopClipAtEnd() {
        return !!(AppState.get('activePlaylistId') || AppState.get('activeCollection'));
    }

    function _stopPoll() {
        if (_pollTimer) {
            clearInterval(_pollTimer);
            _pollTimer = null;
        }
    }

    function setCommandListener(fn) {
        _commandListener = typeof fn === 'function' ? fn : null;
    }

    function getLastMedia() {
        return _lastMedia ? { ..._lastMedia } : null;
    }

    /**
     * Inyecta la fachada LiveCapture (llamar una vez desde app.js tras init).
     * @param {import('./livecapture/LiveCaptureFacade.js').LiveCaptureFacade|null} facade
     */
    function setLiveFacade(facade) {
        _liveFacade = facade;
    }

    /**
     * Activa modo captura propia (oculta superficie YouTube/local).
     * @param {{ sessionId?: string }} [payload]
     */
    function loadLiveCapture(payload = {}) {
        if (!_ready || !_liveFacade) {
            console.warn('YTPlayer: loadLiveCapture sin facade o sin ready');
            return;
        }
        if (!_guardNotRecording('loadLiveCapture')) return;
        // Al entrar a captura, pausar cualquier media previa (YouTube/local) para evitar
        // que quede audio sonando "debajo" de la superficie live.
        try {
            if (_videoPlayer && typeof _videoPlayer.pause === 'function') {
                _videoPlayer.pause();
            }
        } catch (_) { /* noop */ }
        _clipEndSec = null;
        _stopPoll();
        _leaveLiveCaptureIfNeeded();

        _liveFacade.load(payload);
        _lastMedia = {
            kind: 'liveCapture',
            sessionId: payload.sessionId ?? null,
        };
        _emit('mediaLoaded', _lastMedia);
    }

    function init() {
        return new Promise((resolve) => {
            _onReadyCb = resolve;

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', _setupPlayer);
            } else {
                _setupPlayer();
            }
        });
    }

    function _setupPlayer() {
        if (!document.getElementById('youtube-player')) {
            console.warn('YTPlayer: youtube-player element not found');
            return;
        }

        _buildVideoPlayerInstance();
        _ready = true;

        if (_onReadyCb) {
            _onReadyCb();
        }
    }

    function loadVideo(videoId) {
        if (!_ready || !_videoPlayer) return;
        if (!_guardNotRecording('loadVideo')) return;
        const id = String(videoId || '').trim();
        if (!id) return;
        if (getCurrentVideoId() === id && _videoPlayer.type === 'youtube') return;
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();

        _videoPlayer.loadVideo({ type: 'youtube', id });
        _lastMedia = { kind: 'youtube', id };
        _emit('mediaLoaded', _lastMedia);
    }

    function getCurrentLocalUrl() {
        return (_lastMedia && _lastMedia.kind === 'local') ? _lastMedia.url : null;
    }

    function loadLocalVideo(url, file) {
        if (!_ready || !_videoPlayer) return;
        if (!_guardNotRecording('loadLocalVideo')) return;
        const u = String(url || '').trim();
        if (!u) return;
        const resolvedFile = file || AppState.getLocalVideoFile?.() || null;
        if (getCurrentLocalUrl() === u && _videoPlayer.getType?.() === 'local') {
            if (resolvedFile) _lastMedia = { kind: 'local', url: u, file: resolvedFile };
            return;
        }
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();

        _videoPlayer.loadVideo({ type: 'local', url: u });
        _lastMedia = { kind: 'local', url: u, file: resolvedFile };
        _emit('mediaLoaded', _lastMedia);
    }

    /**
     * En vivo (preview) no hay scrub: flechas/timeline llaman seek pero la facade ignora hasta tener replay.
     * Si hay grabación activa, cargamos el DVR hasta ahora (como «Revisar jugada») cuando hace falta y recién ahí seek.
     */
    function seekTo(seconds, opts = {}) {
        if (!_ready || !_engine()) return;
        const sec = Math.max(0, Number(seconds) || 0);
        const fromPopout = !!(opts && opts.fromPopout);

        if (_usingLiveCapture() && _liveFacade && isLiveRecordingActive()) {
            (async () => {
                try {
                    const mode = _liveFacade.getMode?.();
                    let replayDur = 0;
                    if (mode === 'review') {
                        replayDur = _liveFacade.getDuration?.() || 0;
                    }
                    const needsBlob =
                        mode === 'live' ||
                        !Number.isFinite(replayDur) ||
                        replayDur < sec + 0.08;
                    if (needsBlob) {
                        await snapshotReview(_liveFacade);
                    }
                } catch (e) {
                    console.warn('YTPlayer.seekTo (LiveCapture):', e?.message || e);
                    return;
                }
                _engine().seekTo(sec);
                _emit('seek', { seconds: sec });
            })();
            return;
        }

        if (_popoutActive()) {
            _uiTimeOverride = sec;
            _seekEngineSilently(sec);
            if (!fromPopout) _popoutBridge.notifySeek?.(sec);
            return;
        }
        _engine().seekTo(sec);
        _emit('seek', { seconds: sec });
    }

    function play() {
        if (!_ready || !_engine()) return;
        if (_clipAutoPaused) {
            AppState.setCurrentClip(null);
            _clipAutoPaused = false;
        }
        if (_popoutActive()) {
            _popoutBridge.notifyPlay?.();
            try { _engine().play(); } catch (_) { /* noop */ }
            return;
        }
        _engine().play();
    }

    function pause() {
        if (!_ready || !_engine()) return;
        if (_popoutActive()) {
            _popoutBridge.notifyPause?.();
            try { _engine().pause(); } catch (_) { /* noop */ }
            return;
        }
        _engine().pause();
    }

    function togglePlay() {
        if (!_ready || !_engine()) return;
        if (_popoutActive()) {
            if (isPlaying()) pause();
            else play();
            return;
        }
        if (_engine().isPlaying) {
            pause();
        } else {
            play();
        }
    }

    function getCurrentTime() {
        if (!_ready || !_engine()) return 0;
        return _engine().getCurrentTime() || 0;
    }

    function getDuration() {
        if (!_ready || !_engine()) return 0;
        return _engine().getDuration() || 0;
    }

    /**
     * Durante LiveCapture + grabación activa el preview es directo (no se puede buscar).
     * Hay que cargar el replay consolidado hasta ahora (mismo flujo que «Revisar jugada») y ahí sí hacer seek.
     */
    async function playClip(startSec, endSec, options = {}) {
        if (!_ready || !_engine()) return;
        if (_usingLiveCapture() && _liveFacade && isLiveRecordingActive()) {
            try {
                await snapshotReview(_liveFacade);
            } catch (e) {
                console.warn('YTPlayer.playClip (LiveCapture):', e?.message || e);
                return;
            }
        }
        clearClipEnd();
        const stopAtEnd = options.stopAtEnd ?? _shouldStopClipAtEnd();
        if (stopAtEnd) {
            _clipEndSec = endSec;
            _startPoll();
        }
        if (_popoutActive()) {
            _uiTimeOverride = startSec;
            _engine().seekTo(startSec);
            _popoutBridge.notifySeek?.(startSec);
            _popoutBridge.notifyPlay?.();
            try { _engine().play(); } catch (_) { /* noop */ }
            return;
        }
        _engine().seekTo(startSec);
        _engine().play();
        _emit('seek', { seconds: startSec });
    }

    function clearClipEnd() {
        _clipEndSec = null;
        _stopPoll();
    }

    function clearAutoPause() {
        _clipAutoPaused = false;
    }

    function _startPoll() {
        _stopPoll();
        _clipAutoPaused = false;
        _pollTimer = setInterval(() => {
            const eng = _engine();
            if (!eng || _clipEndSec === null) {
                _stopPoll();
                return;
            }
            const t = eng.getCurrentTime();
            if (t >= _clipEndSec) {
                eng.pause();
                _clipEndSec = null;
                _clipAutoPaused = true;
                _stopPoll();
            }
        }, 100);
    }

    function setSpeed(rate) {
        if (!_ready || !_engine()) return;
        _engine().setPlaybackRate(rate);
        _emit('speed', { rate });
    }

    function getVolume() {
        if (!_ready || !_engine()) return 100;
        return _engine().getVolume();
    }

    function setVolume(percent) {
        if (!_ready || !_engine()) return;
        _engine().setVolume(percent);
        if (percent > 0 && _engine().isMuted()) _engine().unMute();
        _emit('volume', { volume: _engine().getVolume(), muted: _engine().isMuted() });
    }

    function isMuted() {
        if (!_ready || !_engine()) return false;
        return _engine().isMuted();
    }

    function mute() {
        if (!_ready || !_engine()) return;
        _engine().mute();
        _emit('volume', { volume: _engine().getVolume(), muted: true });
    }

    function unMute() {
        if (!_ready || !_engine()) return;
        _engine().unMute();
        _emit('volume', { volume: _engine().getVolume(), muted: _engine().isMuted() });
    }

    function toggleMute() {
        if (!_ready || !_engine()) return;
        if (_engine().isMuted()) _engine().unMute();
        else _engine().mute();
        _emit('volume', { volume: _engine().getVolume(), muted: _engine().isMuted() });
    }

    function getSourceType() {
        if (!_ready) return null;
        if (_usingLiveCapture()) return 'liveCapture';
        if (!_videoPlayer || typeof _videoPlayer.getType !== 'function') return null;
        return _videoPlayer.getType();
    }

    function isYoutubeNativeControlsEnabled() {
        return !!_youtubeNativeControlsEnabled;
    }

    async function setYoutubeNativeControlsEnabled(enabled) {
        if (!_ready || !_videoPlayer) return false;
        const next = !!enabled;
        if (_youtubeNativeControlsEnabled === next) return true;
        _youtubeNativeControlsEnabled = next;
        _videoPlayer.setYoutubeShowControls(next);

        if (_lastMedia?.kind !== 'youtube' || !_lastMedia.id) return true;
        const currentTime = getCurrentTime();
        const wasPlaying = isPlaying();
        const selectedQ = (typeof _videoPlayer.getPreferredPlaybackQuality === 'function')
            ? _videoPlayer.getPreferredPlaybackQuality()
            : 'auto';
        try {
            // YouTube controls flag is fixed at iframe creation time; recreate player instance.
            _buildVideoPlayerInstance();
            await _videoPlayer.loadVideo({ type: 'youtube', id: _lastMedia.id });
            if (currentTime > 0) _videoPlayer.seekTo(currentTime);
            if (selectedQ && selectedQ !== 'auto') _videoPlayer.setPlaybackQuality(selectedQ);
            if (wasPlaying) _videoPlayer.play();
            else _videoPlayer.pause();
            return true;
        } catch (_) {
            return false;
        }
    }

    function getAvailableQualities() {
        if (!_ready || _usingLiveCapture() || !_videoPlayer || typeof _videoPlayer.getAvailableQualityLevels !== 'function') {
            return [];
        }
        return _videoPlayer.getAvailableQualityLevels();
    }

    function getPlaybackQuality() {
        if (!_ready || _usingLiveCapture() || !_videoPlayer || typeof _videoPlayer.getPlaybackQuality !== 'function') {
            return 'auto';
        }
        return _videoPlayer.getPlaybackQuality();
    }

    function getPreferredPlaybackQuality() {
        if (!_ready || _usingLiveCapture() || !_videoPlayer || typeof _videoPlayer.getPreferredPlaybackQuality !== 'function') {
            return 'auto';
        }
        return _videoPlayer.getPreferredPlaybackQuality();
    }

    function setPlaybackQuality(quality) {
        if (!_ready || _usingLiveCapture() || !_videoPlayer || typeof _videoPlayer.setPlaybackQuality !== 'function') {
            return false;
        }
        const ok = _videoPlayer.setPlaybackQuality(quality);
        if (ok) _emit('quality', { quality: _videoPlayer.getPlaybackQuality?.() || quality });
        return ok;
    }

    function jumpToLiveEdge() {
        if (!_ready) return;
        if (_usingLiveCapture() && _liveFacade) {
            _liveFacade.jumpToLiveEdge();
            return;
        }
        const eng = _engine();
        if (!eng) return;
        const d = getDuration();
        if (!d || !Number.isFinite(d)) return;
        clearClipEnd();
        const target = Math.max(0, d - 1);
        eng.seekTo(target);
        _emit('seek', { seconds: target });
    }

    function isLiveStream() {
        if (!_ready || !_engine()) return null;
        if (_usingLiveCapture()) return false;
        if (typeof _videoPlayer.isYoutubeLive !== 'function') return null;
        return _videoPlayer.isYoutubeLive();
    }

    function getCurrentVideoId() {
        return (_lastMedia && _lastMedia.kind === 'youtube') ? _lastMedia.id : null;
    }

    async function loadVideoAsync(videoId) {
        if (!_ready || !_videoPlayer || !videoId) return;
        if (!_guardNotRecording('loadVideoAsync')) return;
        const id = String(videoId).trim();
        if (getCurrentVideoId() === id && _videoPlayer.type === 'youtube') return;
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();
        await _videoPlayer.loadVideo({ type: 'youtube', id });
        _lastMedia = { kind: 'youtube', id };
        _emit('mediaLoaded', _lastMedia);
    }

    function getPlayerState() { return -1; }
    function isReady() { return _ready; }
    function isPlaying() {
        if (!_ready) return false;
        if (_usingLiveCapture()) return !!(_liveFacade && _liveFacade.isPlaying);
        if (_videoPlayer && typeof _videoPlayer.isPlayingNow === 'function') {
            return _videoPlayer.isPlayingNow();
        }
        return !!(_videoPlayer && _videoPlayer.isPlaying);
    }

    function setUiTimeOverride(seconds) {
        _uiTimeOverride = (typeof seconds === 'number' && Number.isFinite(seconds)) ? seconds : null;
    }

    function getUiCurrentTime() {
        if (_uiTimeOverride != null) return _uiTimeOverride;
        return getCurrentTime();
    }

    function mirrorRemotePlayback(payload) {
        if (!_ready || !_engine() || !payload || !payload.action) return;
        if (payload.action === 'play' || payload.action === 'pause' || payload.action === 'seek') {
            _armMirrorEchoSuppression(800);
        }
        const eng = _engine();
        const apply = () => {
            if (payload.action === 'seek' && typeof payload.time === 'number') {
                eng.seekTo(payload.time);
            } else if (payload.action === 'play') {
                eng.play();
            } else if (payload.action === 'pause') {
                eng.pause();
            } else if (payload.action === 'volume') {
                if (payload.muted === true) eng.mute();
                else if (payload.muted === false) eng.unMute();
                if (typeof payload.volume === 'number') {
                    eng.setVolume(payload.volume);
                    if (payload.volume > 0 && eng.isMuted()) eng.unMute();
                }
            }
        };
        if (typeof eng.playbackSilenced === 'function') {
            eng.playbackSilenced(async () => { apply(); });
        } else {
            apply();
        }
    }

    return {
        init,
        setLiveFacade,
        loadLiveCapture,
        leaveLiveCapture,
        loadVideo,
        loadVideoAsync,
        getCurrentVideoId,
        loadLocalVideo,
        seekTo,
        play,
        pause,
        togglePlay,
        getCurrentTime,
        getDuration,
        playClip,
        clearClipEnd,
        clearAutoPause,
        isReady,
        isPlaying,
        setUiTimeOverride,
        getUiCurrentTime,
        getPlayerState,
        setSpeed,
        isYoutubeNativeControlsEnabled,
        setYoutubeNativeControlsEnabled,
        getAvailableQualities,
        getPlaybackQuality,
        getPreferredPlaybackQuality,
        setPlaybackQuality,
        getSourceType,
        jumpToLiveEdge,
        isLiveStream,
        setCommandListener,
        setPopoutBridge,
        getLastMedia,
        mirrorRemotePlayback,
        getVolume,
        setVolume,
        isMuted,
        mute,
        unMute,
        toggleMute,
    };
})();
