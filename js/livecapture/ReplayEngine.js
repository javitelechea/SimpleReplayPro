/**
 * Reproductor de replay/DVR sobre un &lt;video&gt; dedicado (#live-replay-video en la app).
 * No mezcla con #youtube-player (YouTube / archivo local).
 */
export class ReplayEngine {
  /**
   * @param {HTMLVideoElement} videoElement
   */
  constructor(videoElement) {
    this._video = videoElement;
    /** @type {string|null} */
    this._objectUrl = null;
  }

  get element() {
    return this._video;
  }

  unload() {
    if (this._objectUrl) {
      try {
        URL.revokeObjectURL(this._objectUrl);
      } catch {
        /* noop */
      }
      this._objectUrl = null;
    }
    this._video.pause?.();
    this._video.removeAttribute('src');
    if (typeof this._video.load === 'function') this._video.load();
  }

  /**
   * Carga un Blob consolidado y mide la duración real (WebM streaming sin duración en header).
   * @param {Blob} blob
   * @returns {Promise<{ reportedDuration: number, realDuration: number, mimeType: string }>}
   */
  async loadBlob(blob) {
    this.unload();
    this._objectUrl = URL.createObjectURL(blob);
    this._video.src = this._objectUrl;

    await new Promise((resolve, reject) => {
      const onErr = () => {
        this._video.removeEventListener('error', onErr);
        reject(new Error('No se pudo cargar el video'));
      };
      this._video.addEventListener('loadedmetadata', () => {
        this._video.removeEventListener('error', onErr);
        resolve();
      }, { once: true });
      this._video.addEventListener('error', onErr, { once: true });
      this._video.load();
    });

    const reported = this._video.duration;
    const realDuration = await measureWebmDuration(this._video);
    return {
      reportedDuration: Number.isFinite(reported) ? reported : NaN,
      realDuration,
      mimeType: blob.type || 'video/webm',
    };
  }
}

/**
 * MediaRecorder-WebM no siempre expone duration hasta escanear; truco habitual en Chrome.
 * @param {HTMLVideoElement} video
 * @returns {Promise<number>}
 */
export function measureWebmDuration(video) {
  return new Promise((resolve) => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      resolve(video.duration);
      return;
    }
    const onChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.removeEventListener('durationchange', onChange);
        const real = video.duration;
        try {
          video.currentTime = 0;
        } catch {
          /* noop */
        }
        resolve(real);
      }
    };
    video.addEventListener('durationchange', onChange);
    try {
      video.currentTime = 1e10;
    } catch {
      resolve(0);
    }
  });
}
