export class VideoPlayer {
    /**
     * @param {string} containerId
     * @param {{ youtubeShowControls?: boolean }} [options] — If false, YouTube hides native UI (use app controls only).
     */
    constructor(containerId, options = {}) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.player = null; // YouTube player or HTML5 Video
        this.type = null; // 'youtube' or 'local'
        this.isPlaying = false;
        this._onPlaybackActivity = null;
        this._playbackSilenced = false;
        this._onYoutubeResize = null;
        this._ytResizeObserver = null;
        this._youtubeShowControls = options.youtubeShowControls !== false;
        this._localNativeControls = options.localNativeControls === true;
        this._preferredYoutubeQuality = 'default';
        this._qualityFallbackLockUntil = 0;

        // Ensure container is styled correctly
        this.container.style.position = 'relative';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.backgroundColor = '#000';
    }

    _youtubeContainerSize() {
        const rect = this.container.getBoundingClientRect();
        let w = Math.floor(rect.width) || this.container.clientWidth || window.innerWidth;
        let h = Math.floor(rect.height) || this.container.clientHeight || window.innerHeight;
        w = Math.max(320, w);
        h = Math.max(180, h);
        return { w, h };
    }

    _fitYoutubeToContainer() {
        if (this.type !== 'youtube' || !this.player || typeof this.player.setSize !== 'function') return;
        const { w, h } = this._youtubeContainerSize();
        try {
            this.player.setSize(w, h);
        } catch (e) {
            console.warn('VideoPlayer: setSize', e);
        }
    }

    _detachYoutubeResize() {
        if (this._onYoutubeResize) {
            window.removeEventListener('resize', this._onYoutubeResize);
            this._onYoutubeResize = null;
        }
        if (this._ytResizeObserver) {
            try { this._ytResizeObserver.disconnect(); } catch (_) { /* noop */ }
            this._ytResizeObserver = null;
        }
    }

    _attachYoutubeResize() {
        this._detachYoutubeResize();
        this._onYoutubeResize = () => this._fitYoutubeToContainer();
        window.addEventListener('resize', this._onYoutubeResize);
        if (typeof ResizeObserver !== 'undefined') {
            this._ytResizeObserver = new ResizeObserver(() => this._fitYoutubeToContainer());
            this._ytResizeObserver.observe(this.container);
        }
    }

    _syncYoutubeIframeInteractivity() {
        if (this.type !== 'youtube' || !this.container) return;
        const iframe = this.container.querySelector('iframe');
        if (!iframe) return;
        iframe.style.pointerEvents = this._youtubeShowControls ? 'auto' : 'none';
    }

    _getYoutubeVideoId() {
        if (this.type !== 'youtube' || !this.player) return null;
        try {
            const data = (typeof this.player.getVideoData === 'function' && this.player.getVideoData()) || {};
            return data.video_id || data.videoId || null;
        } catch (_) {
            return null;
        }
    }

    _switchYoutubeVideo(videoId) {
        return new Promise((resolve) => {
            if (!this.player || typeof this.player.loadVideoById !== 'function') {
                resolve();
                return;
            }
            const onReady = () => {
                this._fitYoutubeToContainer();
                this._attachYoutubeResize();
                this._syncYoutubeIframeInteractivity();
                this._applyYoutubeQualityPreference();
                resolve();
            };
            try {
                this.player.loadVideoById({ videoId, startSeconds: 0 });
            } catch (_) {
                resolve();
                return;
            }
            if (typeof this.player.getPlayerState === 'function') {
                const st = this.player.getPlayerState();
                if (typeof window !== 'undefined' && window.YT && window.YT.PlayerState && st !== window.YT.PlayerState.UNSTARTED) {
                    onReady();
                    return;
                }
            }
            window.setTimeout(onReady, 400);
        });
    }

    _normalizeYoutubeQuality(quality) {
        const q = String(quality || '').trim().toLowerCase();
        if (!q || q === 'auto' || q === 'default' || q === 'unknown') return 'default';
        return q;
    }

    _applyYoutubeQualityPreference({ allowReloadFallback = false } = {}) {
        if (this.type !== 'youtube' || !this.player || typeof this.player.setPlaybackQuality !== 'function') return false;
        const q = this._normalizeYoutubeQuality(this._preferredYoutubeQuality);
        try {
            if (typeof this.player.setPlaybackQualityRange === 'function') {
                if (q === 'default') this.player.setPlaybackQualityRange('default');
                else this.player.setPlaybackQualityRange(q, q);
            }
            this.player.setPlaybackQuality(q);

            // Fallback (user action only): some streams ignore setPlaybackQuality until reload.
            const canFallbackNow = Date.now() >= this._qualityFallbackLockUntil;
            if (allowReloadFallback && canFallbackNow && typeof this.player.loadVideoById === 'function' && typeof this.player.getCurrentTime === 'function') {
                const data = (typeof this.player.getVideoData === 'function' && this.player.getVideoData()) || {};
                const videoId = data.video_id || data.videoId;
                if (videoId && q !== 'default') {
                    this._qualityFallbackLockUntil = Date.now() + 2000;
                    const currentTime = Math.max(0, Number(this.player.getCurrentTime()) || 0);
                    const wasPlaying =
                        typeof this.player.getPlayerState === 'function' &&
                        typeof window !== 'undefined' &&
                        window.YT &&
                        window.YT.PlayerState &&
                        this.player.getPlayerState() === window.YT.PlayerState.PLAYING;
                    this.player.loadVideoById({
                        videoId,
                        startSeconds: currentTime,
                        suggestedQuality: q,
                    });
                    if (!wasPlaying && typeof this.player.pauseVideo === 'function') {
                        this.player.pauseVideo();
                    }
                }
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    setPlaybackActivityCallback(fn) {
        this._onPlaybackActivity = typeof fn === 'function' ? fn : null;
    }

    _dispatchPlaybackActivity(ev) {
        if (this._playbackSilenced || !this._onPlaybackActivity) return;
        try {
            this._onPlaybackActivity(ev);
        } catch (e) {
            console.warn('VideoPlayer: playback activity callback', e);
        }
    }

    async playbackSilenced(fn) {
        this._playbackSilenced = true;
        try {
            return await fn();
        } finally {
            this._playbackSilenced = false;
        }
    }

    async loadVideo(videoData) {
        if (videoData.type === 'youtube') {
            const nextId = String(videoData.id || '').trim();
            if (!nextId) return;
            if (this.type === 'youtube' && this.player) {
                if (this._getYoutubeVideoId() === nextId) return;
                if (!this._youtubeShowControls) {
                    this.container.classList.add('youtube-embed--app-controlled');
                }
                return this._switchYoutubeVideo(nextId);
            }
        }

        if (videoData.type === 'local') {
            const nextUrl = String(videoData.url || '').trim();
            if (!nextUrl) return;
            if (this.type === 'local' && this.player instanceof HTMLVideoElement) {
                const cur = this.player.currentSrc || this.player.src || '';
                if (cur === nextUrl) return Promise.resolve();
            }
        }

        this._detachYoutubeResize();
        this.container.classList.remove('youtube-embed--app-controlled');
        this.container.innerHTML = ''; // Clear previous player
        this.player = null;

        if (videoData.type === 'youtube') {
            this.type = 'youtube';
            if (!this._youtubeShowControls) {
                this.container.classList.add('youtube-embed--app-controlled');
            }
            return new Promise((resolve) => {
                const initYT = () => {
                    const el = document.createElement('div');
                    el.id = 'yt-player-target';
                    el.style.width = '100%';
                    el.style.height = '100%';
                    this.container.appendChild(el);

                    const { w: ytW, h: ytH } = this._youtubeContainerSize();
                    const showCtrls = this._youtubeShowControls;

                    this.player = new YT.Player('yt-player-target', {
                        width: ytW,
                        height: ytH,
                        videoId: videoData.id,
                        playerVars: {
                            'autoplay': 1,
                            'controls': showCtrls ? 1 : 0,
                            'disablekb': showCtrls ? 0 : 1,
                            'modestbranding': 1,
                            'rel': 0,
                            'fs': showCtrls ? 1 : 0,
                            'playsinline': 1,
                            'origin': window.location.origin
                        },
                        events: {
                            'onReady': () => {
                                this._fitYoutubeToContainer();
                                this._attachYoutubeResize();
                                this._syncYoutubeIframeInteractivity();
                                this._applyYoutubeQualityPreference();
                                resolve();
                            },
                            'onStateChange': (event) => {
                                const st = event.data;
                                const YTState = typeof window !== 'undefined' && window.YT && window.YT.PlayerState
                                    ? window.YT.PlayerState
                                    : null;
                                this.isPlaying = YTState
                                    ? (st === YTState.PLAYING || st === YTState.BUFFERING)
                                    : (st === 1);
                                let t = 0;
                                try { t = this.getCurrentTime(); } catch (_) { /* noop */ }
                                if (st === YTState?.PLAYING || st === 1) {
                                    this._dispatchPlaybackActivity({ action: 'play', time: t });
                                } else if (st === YTState?.PAUSED || st === 2) {
                                    this._dispatchPlaybackActivity({ action: 'pause', time: t });
                                }
                            }
                        }
                    });
                };

                if (window.YT && window.YT.Player) {
                    initYT();
                } else {
                    const orig = window.onYouTubeIframeAPIReady;
                    window.onYouTubeIframeAPIReady = () => {
                        if (orig) orig();
                        initYT();
                    };

                    // Load script if not already loading
                    if (!document.getElementById('yt-iframe-api')) {
                        const tag = document.createElement('script');
                        tag.id = 'yt-iframe-api';
                        tag.src = 'https://www.youtube.com/iframe_api';
                        const firstScriptTag = document.getElementsByTagName('script')[0];
                        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
                    }
                }
            });
        } else if (videoData.type === 'local') {
            this.type = 'local';
            return new Promise((resolve, reject) => {
                const video = document.createElement('video');
                video.src = videoData.url;
                video.controls = !!this._localNativeControls;
                video.playsInline = true;
                video.preload = 'auto';
                video.style.width = '100%';
                video.style.height = '100%';
                video.style.objectFit = 'contain';

                let settled = false;
                const timeoutId = setTimeout(
                    () => finish(false, new Error('Tiempo de espera agotado al cargar el video')),
                    30000
                );
                const finish = (ok, err) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeoutId);
                    video.removeEventListener('loadedmetadata', onReady);
                    video.removeEventListener('error', onError);
                    if (ok) resolve();
                    else reject(err || new Error('No se pudo cargar el video local'));
                };
                const onReady = () => finish(true);
                const onError = () => finish(false, new Error('URL de video no válida en el player externo'));

                video.addEventListener('loadedmetadata', onReady);
                video.addEventListener('error', onError);
                if (video.readyState >= 1) onReady();

                video.addEventListener('play', () => {
                    this.isPlaying = true;
                    this._dispatchPlaybackActivity({ action: 'play', time: video.currentTime || 0 });
                });
                video.addEventListener('pause', () => {
                    this.isPlaying = false;
                    this._dispatchPlaybackActivity({ action: 'pause', time: video.currentTime || 0 });
                });
                video.addEventListener('seeked', () => {
                    this._dispatchPlaybackActivity({ action: 'seek', time: video.currentTime || 0 });
                });

                this.container.appendChild(video);
                this.player = video;

                video.play().catch(() => { /* autoplay bloqueado */ });
            });
        }
    }

    isPlayingNow() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.getPlayerState === 'function') {
                const st = this.player.getPlayerState();
                const YTState = typeof window !== 'undefined' && window.YT && window.YT.PlayerState
                    ? window.YT.PlayerState
                    : null;
                if (YTState) {
                    return st === YTState.PLAYING || st === YTState.BUFFERING;
                }
                return st === 1;
            }
            if (this.type === 'local' && this.player) {
                return !this.player.paused && !this.player.ended;
            }
        } catch (_) { /* noop */ }
        return !!this.isPlaying;
    }

    play() {
        if (this.type === 'youtube' && this.player && this.player.playVideo) {
            this.player.playVideo();
        } else if (this.type === 'local' && this.player) {
            this.player.play();
        }
    }

    pause() {
        if (this.type === 'youtube' && this.player && this.player.pauseVideo) {
            this.player.pauseVideo();
        } else if (this.type === 'local' && this.player) {
            this.player.pause();
        }
    }

    /**
     * @returns {number} Current time in seconds
     */
    getCurrentTime() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.getCurrentTime === 'function') {
                return this.player.getCurrentTime();
            } else if (this.type === 'local' && this.player) {
                return this.player.currentTime || 0;
            }
        } catch (e) {
            console.error('Error in getCurrentTime:', e);
        }
        return 0;
    }

    /**
     * @returns {number} Video duration in seconds
     */
    getDuration() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.getDuration === 'function') {
                return this.player.getDuration();
            } else if (this.type === 'local' && this.player) {
                return this.player.duration || 0;
            }
        } catch (e) {
            console.error('Error in getDuration:', e);
        }
        return 0;
    }

    /**
     * @param {number} time In seconds
     */
    seekTo(time) {
        if (this.type === 'youtube' && this.player && this.player.seekTo) {
            this.player.seekTo(time, true);
        } else if (this.type === 'local' && this.player) {
            this.player.currentTime = time;
        }
    }

    setPlaybackRate(rate) {
        if (this.type === 'youtube' && this.player && this.player.setPlaybackRate) {
            this.player.setPlaybackRate(rate);
        } else if (this.type === 'local' && this.player) {
            this.player.playbackRate = rate;
        }
    }

    /**
     * @returns {number} 0–100
     */
    getVolume() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.getVolume === 'function') {
                const v = this.player.getVolume();
                if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(100, Math.round(v)));
            } else if (this.type === 'local' && this.player) {
                return Math.round(Math.max(0, Math.min(1, this.player.volume || 0)) * 100);
            }
        } catch (_) { /* noop */ }
        return 100;
    }

    /**
     * @param {number} percent 0–100
     */
    setVolume(percent) {
        const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.setVolume === 'function') {
                this.player.setVolume(v);
            } else if (this.type === 'local' && this.player) {
                this.player.volume = v / 100;
            }
        } catch (_) { /* noop */ }
    }

    isMuted() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.isMuted === 'function') {
                return !!this.player.isMuted();
            } else if (this.type === 'local' && this.player) {
                return !!this.player.muted;
            }
        } catch (_) { /* noop */ }
        return false;
    }

    mute() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.mute === 'function') {
                this.player.mute();
            } else if (this.type === 'local' && this.player) {
                this.player.muted = true;
            }
        } catch (_) { /* noop */ }
    }

    unMute() {
        try {
            if (this.type === 'youtube' && this.player && typeof this.player.unMute === 'function') {
                this.player.unMute();
            } else if (this.type === 'local' && this.player) {
                this.player.muted = false;
            }
        } catch (_) { /* noop */ }
    }

    getType() {
        return this.type;
    }

    setYoutubeShowControls(enabled) {
        this._youtubeShowControls = enabled !== false;
        this._syncYoutubeIframeInteractivity();
    }

    getAvailableQualityLevels() {
        if (this.type !== 'youtube' || !this.player || typeof this.player.getAvailableQualityLevels !== 'function') {
            return [];
        }
        try {
            const levels = this.player.getAvailableQualityLevels();
            return Array.isArray(levels) ? levels.filter(Boolean) : [];
        } catch (_) {
            return [];
        }
    }

    getPlaybackQuality() {
        if (this.type !== 'youtube' || !this.player || typeof this.player.getPlaybackQuality !== 'function') {
            return 'auto';
        }
        try {
            const q = this.player.getPlaybackQuality();
            if (!q || q === 'default' || q === 'unknown') return 'auto';
            return q;
        } catch (_) {
            return 'auto';
        }
    }

    getPreferredPlaybackQuality() {
        const q = this._normalizeYoutubeQuality(this._preferredYoutubeQuality);
        return q === 'default' ? 'auto' : q;
    }

    setPlaybackQuality(quality) {
        if (this.type !== 'youtube' || !this.player || typeof this.player.setPlaybackQuality !== 'function') {
            return false;
        }
        const q = this._normalizeYoutubeQuality(quality);
        const available = this.getAvailableQualityLevels();
        if (q !== 'default' && available.length && !available.includes(q)) return false;
        this._preferredYoutubeQuality = q;
        return this._applyYoutubeQualityPreference({ allowReloadFallback: true });
    }

    isYoutubeLive() {
        if (this.type !== 'youtube' || !this.player) return false;
        try {
            // YouTube iframe API may expose live hints in getVideoData().
            if (typeof this.player.getVideoData === 'function') {
                const data = this.player.getVideoData() || {};
                if (data.isLive === true || data.isLiveContent === true) return true;
                if (data.isLive === false || data.isLiveContent === false) return false;
            }
        } catch (e) {
            // ignore and fallback
        }
        return null; // unknown
    }
}
