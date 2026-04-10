export class VideoPlayer {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.player = null; // YouTube player or HTML5 Video
        this.type = null; // 'youtube' or 'local'
        this.isPlaying = false;

        // Ensure container is styled correctly
        this.container.style.position = 'relative';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.backgroundColor = '#000';
    }

    async loadVideo(videoData) {
        this.container.innerHTML = ''; // Clear previous player

        if (videoData.type === 'youtube') {
            this.type = 'youtube';
            return new Promise((resolve) => {
                const initYT = () => {
                    console.log('VideoPlayer: initYT executing for', videoData.id);
                    const el = document.createElement('div');
                    el.id = 'yt-player-target';
                    this.container.appendChild(el);

                    this.player = new YT.Player('yt-player-target', {
                        videoId: videoData.id,
                        playerVars: {
                            'autoplay': 1,
                            'controls': 1,
                            'modestbranding': 1,
                            'rel': 0,
                            'fs': 1,
                            'playsinline': 1,
                            'origin': window.location.origin
                        },
                        events: {
                            'onReady': () => {
                                console.log('VideoPlayer: YT Player Ready');
                                resolve();
                            },
                            'onStateChange': (event) => {
                                this.isPlaying = event.data === YT.PlayerState.PLAYING;
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

                video.addEventListener('play', () => this.isPlaying = true);
                video.addEventListener('pause', () => this.isPlaying = false);

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

    getDuration() {
        try {
            if (this.type === 'youtube' && this.player && this.player.getDuration) {
                return this.player.getDuration();
            } else if (this.type === 'local' && this.player) {
                return this.player.duration;
            }
        } catch (e) {
            console.warn('VideoPlayer: Error getting duration', e);
        }
        return 0;
    }

    setPlaybackRate(rate) {
        if (this.type === 'youtube' && this.player && this.player.setPlaybackRate) {
            this.player.setPlaybackRate(rate);
        } else if (this.type === 'local' && this.player) {
            this.player.playbackRate = rate;
        }
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
