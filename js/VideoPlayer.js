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
        this._detachYoutubeResize();
        this.container.classList.remove('youtube-embed--app-controlled');
        this.container.innerHTML = ''; // Clear previous player

        if (videoData.type === 'youtube') {
            this.type = 'youtube';
            if (!this._youtubeShowControls) {
                this.container.classList.add('youtube-embed--app-controlled');
            }
            return new Promise((resolve) => {
                const initYT = () => {
                    console.log('VideoPlayer: initYT executing for', videoData.id);
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
                                console.log('VideoPlayer: YT Player Ready');
                                this._fitYoutubeToContainer();
                                this._attachYoutubeResize();
                                resolve();
                            },
                            'onStateChange': (event) => {
                                const st = event.data;
                                this.isPlaying = st === YT.PlayerState.PLAYING;
                                let t = 0;
                                try { t = this.getCurrentTime(); } catch (_) { /* noop */ }
                                if (st === YT.PlayerState.PLAYING) {
                                    this._dispatchPlaybackActivity({ action: 'play', time: t });
                                } else if (st === YT.PlayerState.PAUSED) {
                                    this._dispatchPlaybackActivity({ action: 'pause', time: t });
                                }
                            }
                        }
                    });
                };

                console.log('VideoPlayer: Checking for window.YT', !!window.YT);
                if (window.YT && window.YT.Player) {
                    initYT();
                } else {
                    console.log('VideoPlayer: Waiting for onYouTubeIframeAPIReady');
                    const orig = window.onYouTubeIframeAPIReady;
                    window.onYouTubeIframeAPIReady = () => {
                        console.log('VideoPlayer: onYouTubeIframeAPIReady triggered');
                        if (orig) orig();
                        initYT();
                    };

                    // Load script if not already loading
                    if (!document.getElementById('yt-iframe-api')) {
                        console.log('VideoPlayer: Injecting YouTube IFrame API script');
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
            return new Promise((resolve) => {
                const video = document.createElement('video');
                video.src = videoData.url;
                video.controls = true;
                video.style.width = '100%';
                video.style.height = '100%';
                video.style.objectFit = 'contain';

                video.addEventListener('loadedmetadata', () => {
                    resolve();
                });

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

                // Auto-play locally
                video.play().catch(e => console.warn('Autoplay prevented', e));
            });
        }
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
