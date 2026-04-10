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

        _videoPlayer = new VideoPlayer('youtube-player');
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
        }
    }

    function loadLocalVideo(url) {
        if (!_ready || !_videoPlayer) return;
        _clipEndSec = null;
        _stopPoll();

        if (url) {
            _videoPlayer.loadVideo({ type: 'local', url: url });
        }
    }

    function seekTo(seconds) {
        if (!_ready || !_videoPlayer) return;
        _videoPlayer.seekTo(seconds);
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
        _videoPlayer.seekTo(Math.max(0, d - 1));
    }

    function isLiveStream() {
        if (!_ready || !_videoPlayer || typeof _videoPlayer.isYoutubeLive !== 'function') return null;
        return _videoPlayer.isYoutubeLive();
    }

    // Dummy for compatibility
    function getPlayerState() { return -1; }
    function isReady() { return _ready; }

    return { init, loadVideo, loadLocalVideo, seekTo, play, pause, togglePlay, getCurrentTime, getDuration, playClip, clearClipEnd, clearAutoPause, isReady, getPlayerState, setSpeed, getSourceType, jumpToLiveEdge, isLiveStream };
})();
