/* ═══════════════════════════════════════════
   SimpleReplay — YouTube/Local Player Wrapper
   Provides a compatible YTPlayer interface while using VideoPlayer
   ═══════════════════════════════════════════ */

import { VideoPlayer } from './VideoPlayer.js';
import { AppState } from './state.js';

export const YTPlayer = (() => {
    let _videoPlayer = null;
    let _ready = false;
    let _clipEndSec = null;
    let _pollTimer = null;
    let _onReadyCb = null;
    let _clipAutoPaused = false;
    let _lastMedia = null;
    let _commandListener = null;
    let _suppressMirrorEchoUntil = 0;

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

    function init() {
        console.log('YTPlayer wrapper: init() called');
        return new Promise((resolve) => {
            _onReadyCb = resolve;

            // Wait for DOM to be ready
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

        // Sin UI nativa de YouTube en la app: así no se usa el iframe por error y todo pasa por timeline/atajos/popup.
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
        _clipEndSec = null;
        _stopPoll();

        if (url) {
            _videoPlayer.loadVideo({ type: 'local', url: url });
            _lastMedia = { kind: 'local', url, file: file || null };
            _emit('mediaLoaded', _lastMedia);
        }
    }

    function seekTo(seconds) {
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.seekTo(seconds);
        _emit('seek', { seconds });
    }

    function play() {
        if (!_ready || !_videoPlayer) return;
        if (_clipAutoPaused) {
            AppState.setCurrentClip(null);
            _clipAutoPaused = false;
        }
        _videoPlayer.play();
    }

    function pause() {
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.pause();
    }

    function togglePlay() {
        if (!_ready || !_videoPlayer) return;
        if (_videoPlayer.isPlaying) {
            pause();
        } else {
            play();
        }
    }

    function getCurrentTime() {
        if (!_ready || !_videoPlayer) return 0;
        return _videoPlayer.getCurrentTime() || 0;
    }

    function getDuration() {
        if (!_ready || !_videoPlayer) return 0;
        return _videoPlayer.getDuration() || 0;
    }

    function playClip(startSec, endSec) {
        if (!_ready || !_videoPlayer) return;
        _clipEndSec = endSec;
        _videoPlayer.seekTo(startSec);
        _videoPlayer.play();
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
            if (!_videoPlayer || _clipEndSec === null) { _stopPoll(); return; }
            const t = _videoPlayer.getCurrentTime();
            if (t >= _clipEndSec + 5) {
                _videoPlayer.pause();
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
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.setPlaybackRate(rate);
        _emit('speed', { rate });
    }

    function getVolume() {
        if (!_ready || !_videoPlayer) return 100;
        return _videoPlayer.getVolume();
    }

    function setVolume(percent) {
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.setVolume(percent);
        if (percent > 0 && _videoPlayer.isMuted()) _videoPlayer.unMute();
        _emit('volume', { volume: _videoPlayer.getVolume(), muted: _videoPlayer.isMuted() });
    }

    function isMuted() {
        if (!_ready || !_videoPlayer) return false;
        return _videoPlayer.isMuted();
    }

    function mute() {
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.mute();
        _emit('volume', { volume: _videoPlayer.getVolume(), muted: true });
    }

    function unMute() {
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.unMute();
        _emit('volume', { volume: _videoPlayer.getVolume(), muted: _videoPlayer.isMuted() });
    }

    function toggleMute() {
        if (!_ready || !_videoPlayer) return;
        if (_videoPlayer.isMuted()) _videoPlayer.unMute();
        else _videoPlayer.mute();
        _emit('volume', { volume: _videoPlayer.getVolume(), muted: _videoPlayer.isMuted() });
    }

    function getSourceType() {
        if (!_videoPlayer || typeof _videoPlayer.getType !== 'function') return null;
        return _videoPlayer.getType();
    }

    function jumpToLiveEdge() {
        if (!_ready || !_videoPlayer) return;
        const d = getDuration();
        if (!d || !Number.isFinite(d)) return;
        clearClipEnd();
        const target = Math.max(0, d - 1);
        _videoPlayer.seekTo(target);
        _emit('seek', { seconds: target });
    }

    function isLiveStream() {
        if (!_ready || !_videoPlayer || typeof _videoPlayer.isYoutubeLive !== 'function') return null;
        return _videoPlayer.isYoutubeLive();
    }

    function getCurrentVideoId() {
        return (_lastMedia && _lastMedia.kind === 'youtube') ? _lastMedia.id : null;
    }

    async function loadVideoAsync(videoId) {
        if (!_ready || !_videoPlayer || !videoId) return;
        _clipEndSec = null;
        _stopPoll();
        await _videoPlayer.loadVideo({ type: 'youtube', id: videoId });
        _lastMedia = { kind: 'youtube', id: videoId };
        _emit('mediaLoaded', _lastMedia);
    }

    // Dummy for compatibility
    function getPlayerState() { return -1; }
    function isReady() { return _ready; }
    function isPlaying() { return !!(_videoPlayer && _videoPlayer.isPlaying); }

    /** Apply play/pause/seek from the popout window (bypasses duplicate _emit). */
    function mirrorRemotePlayback(payload) {
        if (!_ready || !_videoPlayer || !payload || !payload.action) return;
        if (payload.action === 'play' || payload.action === 'pause' || payload.action === 'seek') {
            _armMirrorEchoSuppression(800);
        }
        const apply = () => {
            if (payload.action === 'seek' && typeof payload.time === 'number') {
                _videoPlayer.seekTo(payload.time);
            } else if (payload.action === 'play') {
                _videoPlayer.play();
            } else if (payload.action === 'pause') {
                _videoPlayer.pause();
            } else if (payload.action === 'volume') {
                if (payload.muted === true) _videoPlayer.mute();
                else if (payload.muted === false) _videoPlayer.unMute();
                if (typeof payload.volume === 'number') {
                    _videoPlayer.setVolume(payload.volume);
                    if (payload.volume > 0 && _videoPlayer.isMuted()) _videoPlayer.unMute();
                }
            }
        };
        // Prevent main<->popout feedback loop:
        // remote playback commands should not emit playback activity back to popout.
        if (typeof _videoPlayer.playbackSilenced === 'function') {
            _videoPlayer.playbackSilenced(async () => { apply(); });
        } else {
            apply();
        }
    }

    return { init, loadVideo, loadVideoAsync, getCurrentVideoId, loadLocalVideo, seekTo, play, pause, togglePlay, getCurrentTime, getDuration, playClip, clearClipEnd, clearAutoPause, isReady, isPlaying, getPlayerState, setSpeed, getSourceType, jumpToLiveEdge, isLiveStream, setCommandListener, getLastMedia, mirrorRemotePlayback, getVolume, setVolume, isMuted, mute, unMute, toggleMute };
})();
