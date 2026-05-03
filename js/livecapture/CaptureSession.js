/**
 * Ciclo de vida de getUserMedia (video, sin audio en v1).
 */
export class CaptureSession {
  /**
   * @param {MediaStreamConstraints} constraints — típ. buildVideoConstraints(...)
   */
  constructor(constraints) {
    this._constraints = constraints;
    /** @type {MediaStream|null} */
    this._stream = null;
  }

  /**
   * @returns {Promise<MediaStream>}
   */
  async open() {
    this.close();
    this._stream = await navigator.mediaDevices.getUserMedia(this._constraints);
    return this._stream;
  }

  close() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }

  /** @returns {MediaStream|null} */
  getStream() {
    return this._stream;
  }

  /** Settings del primer video track, si existe. */
  getVideoSettings() {
    const s = this._stream?.getVideoTracks?.()?.[0];
    return s ? s.getSettings() : null;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.deviceId]
 * @param {'720'|'1080'|'any'} [opts.resolution]
 * @returns {MediaStreamConstraints}
 */
export function buildVideoConstraints(opts = {}) {
  const { deviceId, resolution = 'any' } = opts;
  const video = {
    deviceId: deviceId ? { exact: deviceId } : undefined,
  };
  if (resolution === '720') {
    Object.assign(video, {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  } else if (resolution === '1080') {
    Object.assign(video, {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    });
  }
  return { audio: false, video };
}
