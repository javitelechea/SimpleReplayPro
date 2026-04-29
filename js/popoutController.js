/* ═══════════════════════════════════════════
   SimpleReplay — Popout Controller
   Opens a separate window with just the video player and keeps it
   in sync with the main app via BroadcastChannel.
   ═══════════════════════════════════════════ */

const CHANNEL_NAME = 'simplereplay-popout';

export const PopoutController = (() => {
    let _channel = null;
    let _popupWindow = null;
    let _watchTimer = null;
    let _syncTimer = null;
    let _handshakeTimer = null;
    let _ready = false;
    let _activeListeners = new Set();
    let _lastMedia = null;
    let _provider = null;
    let _mirrorHandler = null;

    function _emitState() {
        const active = isActive();
        _activeListeners.forEach(fn => {
            try { fn(active); } catch (_) { /* noop */ }
        });
    }

    function setProvider(provider) {
        _provider = provider || null;
    }

    function setMirrorHandler(fn) {
        _mirrorHandler = typeof fn === 'function' ? fn : null;
    }

    function onActiveChange(fn) {
        if (typeof fn !== 'function') return () => {};
        _activeListeners.add(fn);
        return () => _activeListeners.delete(fn);
    }

    function isActive() {
        return !!(_popupWindow && !_popupWindow.closed);
    }

    function isConnected() {
        return !!(_channel && _ready);
    }

    function _ensureChannel() {
        if (_channel) return _channel;
        _channel = new BroadcastChannel(CHANNEL_NAME);
        _channel.addEventListener('message', (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'ready') {
                _ready = true;
                _clearHandshakeTimer();
                _sendInitialSync();
                _startContinuousSync();
            } else if (msg.type === 'pong') {
                // Re-handshake path when popup was already open before main reloaded.
                _ready = true;
                _clearHandshakeTimer();
                _sendInitialSync();
                _startContinuousSync();
            } else if (msg.type === 'closing') {
                _ready = false;
                _stopContinuousSync();
            } else if (msg.type === 'mirror' && _mirrorHandler) {
                _mirrorHandler(msg.payload);
            }
        });
        return _channel;
    }

    function _sendInitialSync() {
        if (!_ready || !_channel || !_provider) return;
        const snapshot = _safe(() => _provider.getSnapshot());
        if (!snapshot) return;
        _channel.postMessage({ type: 'sync', payload: snapshot });
        _lastMedia = snapshot.media || _lastMedia;
    }

    function _startContinuousSync() {
        _stopContinuousSync();
        _syncTimer = setInterval(() => {
            if (!_ready || !_channel || !_provider) return;
            const snapshot = _safe(() => _provider.getSnapshot());
            if (!snapshot) return;
            try {
                _channel.postMessage({ type: 'sync', payload: snapshot });
            } catch (_) { /* noop */ }
        }, 700);
    }

    function _stopContinuousSync() {
        if (_syncTimer) {
            clearInterval(_syncTimer);
            _syncTimer = null;
        }
    }

    function _safe(fn) {
        try { return fn(); } catch (_) { return null; }
    }

    function _playerUrl() {
        return `player.html?v=${Date.now()}`;
    }

    function _clearHandshakeTimer() {
        if (_handshakeTimer) {
            clearTimeout(_handshakeTimer);
            _handshakeTimer = null;
        }
    }

    function _scheduleHandshakeRecovery() {
        _clearHandshakeTimer();
        _handshakeTimer = setTimeout(() => {
            if (!isActive() || _ready) return;
            try {
                _popupWindow.location.replace(_playerUrl());
            } catch (_) { /* noop */ }
        }, 1400);
    }

    function open() {
        if (isActive()) {
            _ensureChannel();
            _ready = false;
            try { _channel.postMessage({ type: 'ping' }); } catch (_) { /* noop */ }
            _scheduleHandshakeRecovery();
            try { _popupWindow.focus(); } catch (_) { /* noop */ }
            return true;
        }
        const features = 'popup,width=960,height=560,resizable=yes,scrollbars=no';
        const win = window.open(_playerUrl(), 'sr-popout', features);
        if (!win) {
            return false;
        }
        _popupWindow = win;
        _ready = false;
        _ensureChannel();
        _scheduleHandshakeRecovery();
        _watchClose();
        _emitState();
        return true;
    }

    function close() {
        if (_channel) {
            try { _channel.postMessage({ type: 'close' }); } catch (_) { /* noop */ }
        }
        if (_popupWindow && !_popupWindow.closed) {
            try { _popupWindow.close(); } catch (_) { /* noop */ }
        }
        _stopWatch();
        _stopContinuousSync();
        _clearHandshakeTimer();
        _popupWindow = null;
        _ready = false;
        _emitState();
    }

    function _watchClose() {
        _stopWatch();
        _watchTimer = setInterval(() => {
            if (_popupWindow && _popupWindow.closed) {
                _stopWatch();
                _stopContinuousSync();
                _clearHandshakeTimer();
                _popupWindow = null;
                _ready = false;
                _emitState();
            }
        }, 1000);
    }

    function _stopWatch() {
        if (_watchTimer) {
            clearInterval(_watchTimer);
            _watchTimer = null;
        }
    }

    function send(type, payload) {
        if (!_channel || !_ready) return;
        try {
            _channel.postMessage(payload === undefined ? { type } : { type, payload });
        } catch (_) { /* noop */ }
    }

    function notifyMediaLoaded(media) {
        _lastMedia = media || null;
        if (!_channel || !_ready) return;
        if (_ready) {
            send('load', media);
        } else {
            // Will be picked up by initial sync once popup signals ready.
        }
    }

    function notifyPlay() { send('play'); }
    function notifyPause() { send('pause'); }
    function notifySeek(seconds) {
        if (typeof seconds !== 'number') return;
        send('seek', { seconds });
    }
    function notifySpeed(rate) {
        if (typeof rate !== 'number') return;
        send('speed', { rate });
    }
    function notifyVolume(payload) {
        if (!payload || typeof payload !== 'object') return;
        send('volume', payload);
    }

    return {
        setProvider,
        setMirrorHandler,
        onActiveChange,
        isActive,
        isConnected,
        open,
        close,
        notifyMediaLoaded,
        notifyPlay,
        notifyPause,
        notifySeek,
        notifySpeed,
        notifyVolume
    };
})();
