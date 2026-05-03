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
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();

        _liveFacade.load(payload);
        _lastMedia = {
            kind: 'liveCapture',
            sessionId: payload.sessionId ?? null,
        };
        _emit('mediaLoaded', _lastMedia);
    }

    function init() {
        console.log('YTPlayer wrapper: init() called');
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
        console.log('YTPlayer wrapper: _setupPlayer executing');
        if (!document.getElementById('youtube-player')) {
            console.warn('YTPlayer: youtube-player element not found');
            return;
        }

        _videoPlayer = new VideoPlayer('youtube-player', { youtubeShowControls: false });
        _videoPlayer.setPlaybackActivityCallback((ev) => {
            if (!ev || !ev.action) return;
            if (ev.action === 'play') _emit('play');
            else if (ev.action === 'pause') _emit('pause');
            else if (ev.action === 'seek' && typeof ev.time === 'number') _emit('seek', { seconds: ev.time });
        });
        _ready = true;
        console.log('YTPlayer wrapper: player instance created, ready');

        if (_onReadyCb) {
            _onReadyCb();
        }
    }

    function loadVideo(videoId) {
        console.log('YTPlayer wrapper: loadVideo called with', videoId);
        if (!_ready || !_videoPlayer) {
            console.log('YTPlayer wrapper: NOT READY. _ready:', _ready, '_videoPlayer:', !!_videoPlayer);
            return;
        }
        if (!_guardNotRecording('loadVideo')) return;
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();

        if (videoId) {
            _videoPlayer.loadVideo({ type: 'youtube', id: videoId });
            _lastMedia = { kind: 'youtube', id: videoId };
            _emit('mediaLoaded', _lastMedia);
        }
    }

    function loadLocalVideo(url, file) {
        if (!_ready || !_videoPlayer) return;
        if (!_guardNotRecording('loadLocalVideo')) return;
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();

        if (url) {
            _videoPlayer.loadVideo({ type: 'local', url: url });
            _lastMedia = { kind: 'local', url, file: file || null };
            _emit('mediaLoaded', _lastMedia);
        }
    }

    /**
     * En vivo (preview) no hay scrub: flechas/timeline llaman seek pero la facade ignora hasta tener replay.
     * Si hay grabación activa, cargamos el DVR hasta ahora (como «Revisar jugada») cuando hace falta y recién ahí seek.
     */
    function seekTo(seconds) {
        if (!_ready || !_engine()) return;
        const sec = Math.max(0, Number(seconds) || 0);

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

        _engine().seekTo(sec);
        _emit('seek', { seconds: sec });
    }

    function play() {
        if (!_ready || !_engine()) return;
        if (_clipAutoPaused) {
            AppState.setCurrentClip(null);
            _clipAutoPaused = false;
        }
        _engine().play();
    }

    function pause() {
        if (!_ready || !_engine()) return;
        _engine().pause();
    }

    function togglePlay() {
        if (!_ready || !_engine()) return;
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
    async function playClip(startSec, endSec) {
        if (!_ready || !_engine()) return;
        if (_usingLiveCapture() && _liveFacade && isLiveRecordingActive()) {
            try {
                await snapshotReview(_liveFacade);
            } catch (e) {
                console.warn('YTPlayer.playClip (LiveCapture):', e?.message || e);
                return;
            }
        }
        _clipEndSec = endSec;
        _engine().seekTo(startSec);
        _engine().play();
        _emit('seek', { seconds: startSec });
        _startPoll();
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
            if (!eng || _clipEndSec === null) { _stopPoll(); return; }
            const t = eng.getCurrentTime();
            if (t >= _clipEndSec + 5) {
                eng.pause();
                _clipEndSec = null;
                _clipAutoPaused = true;
                _stopPoll();
            }
        }, 100);
    }

    function _stopPoll() {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
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
        _leaveLiveCaptureIfNeeded();
        _clipEndSec = null;
        _stopPoll();
        await _videoPlayer.loadVideo({ type: 'youtube', id: videoId });
        _lastMedia = { kind: 'youtube', id: videoId };
        _emit('mediaLoaded', _lastMedia);
    }

    function getPlayerState() { return -1; }
    function isReady() { return _ready; }
    function isPlaying() {
        if (!_ready) return false;
        if (_usingLiveCapture()) return !!(_liveFacade && _liveFacade.isPlaying);
        return !!(_videoPlayer && _videoPlayer.isPlaying);
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
        getPlayerState,
        setSpeed,
        getSourceType,
        jumpToLiveEdge,
        isLiveStream,
        setCommandListener,
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
