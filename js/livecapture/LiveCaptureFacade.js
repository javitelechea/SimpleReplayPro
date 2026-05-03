/**
 * Fachada del reproductor para videoSource `liveCapture`.
 * No usa VideoPlayer ni #youtube-player; usa #live-preview-video y #live-replay-video.
 *
 * Fase 2: contrato compatible con lo que delega YTPlayer; captura real en Fase 3+.
 */

import { SessionClock } from './SessionClock.js';
import { ReplayEngine } from './ReplayEngine.js';

export const LIVE_CAPTURE_ENGINE_TYPE = 'liveCapture';

export class LiveCaptureFacade {
  constructor() {
    /** @type {HTMLDivElement|null} */
    this._youtubeSlot = null;
    /** @type {HTMLVideoElement|null} */
    this._preview = null;
    /** @type {HTMLVideoElement|null} */
    this._replay = null;

    /** @type {'live'|'review'} */
    this._mode = 'live';

    /** @type {SessionClock|null} */
    this._clock = new SessionClock();

    /** @type {ReplayEngine|null} */
    this._replayEngine = null;

    this._sessionId = null;
    this._active = false;

    /** Compat con VideoPlayer.isPlaying */
    this.isPlaying = false;

    this._playbackSilenced = false;
  }

  /**
   * Enlaza elementos del DOM principal (ids fijos acordados con index.html).
   */
  initFromDom() {
    this._youtubeSlot = document.getElementById('youtube-player');
    this._preview = document.getElementById('live-preview-video');
    this._replay = document.getElementById('live-replay-video');
  }

  /**
   * @param {{ youtubeContainer?: HTMLElement, previewVideo?: HTMLVideoElement, replayVideo?: HTMLVideoElement }} el
   */
  init(el = {}) {
    if (el.youtubeContainer) this._youtubeSlot = el.youtubeContainer;
    if (el.previewVideo) this._preview = el.previewVideo;
    if (el.replayVideo) this._replay = el.replayVideo;
  }

  /**
   * Entra en modo LiveCapture (oculta YouTube/local, muestra superficie de captura).
   * @param {{ sessionId?: string }} [payload]
   */
  load(payload = {}) {
    this.unload();
    this._sessionId = payload.sessionId ?? null;
    this._active = true;
    this._mode = 'live';
    this._clock = new SessionClock();
    this.isPlaying = false;
    this._showLiveSurfaces();
  }

  /**
   * Sale de LiveCapture y restaura #youtube-player.
   */
  unload() {
    if (this._preview?.srcObject) {
      try {
        this._preview.srcObject.getTracks().forEach((t) => t.stop());
      } catch {
        /* noop */
      }
      this._preview.srcObject = null;
    }
    this._replayEngine?.unload();
    this._replayEngine = null;

    this._sessionId = null;
    this._active = false;
    this._mode = 'live';
    this.isPlaying = false;
    if (this._clock) this._clock.reset();
    this._hideLiveSurfaces();
  }

  /** Igual que VideoPlayer.getType — usa LIVE_CAPTURE_ENGINE_TYPE para YTPlayer.getSourceType */
  getType() {
    return LIVE_CAPTURE_ENGINE_TYPE;
  }

  getSessionId() {
    return this._sessionId;
  }

  isActive() {
    return this._active;
  }

  getMode() {
    return this._mode;
  }

  /** Reloj de sesión (p.ej. cuando arranca MediaRecorder en Fase 3). */
  getSessionClock() {
    return this._clock;
  }

  /**
   * Preview del vivo (MediaStream). Pasar `null` para apagar cámara y limpiar el elemento.
   * @param {MediaStream|null} stream
   */
  attachPreviewStream(stream) {
    if (!this._preview) return;
    if (!stream) {
      if (this._preview.srcObject) {
        try {
          this._preview.srcObject.getTracks().forEach((t) => t.stop());
        } catch {
          /* noop */
        }
      }
      this._preview.srcObject = null;
      return;
    }
    this._preview.srcObject = stream;
  }

  /** Volver al vivo (oculta replay, muestra preview). */
  goLive() {
    if (!this._active) return;
    this._mode = 'live';
    this._replayEngine?.unload();
    this._replayEngine = null;
    this.isPlaying = false;
    this._replay?.classList.add('hidden');
    this._preview?.classList.remove('hidden');
  }

  /**
   * Carga un snapshot consolidado en el video de replay (revisión DVR).
   * @param {Blob} blob
   * @returns {Promise<{ realDuration: number }>}
   */
  async enterReviewWithBlob(blob) {
    if (!this._active || !this._replay) return { realDuration: 0 };
    if (!this._replayEngine) this._replayEngine = new ReplayEngine(this._replay);
    const { realDuration } = await this._replayEngine.loadBlob(blob);
    this._mode = 'review';
    this._preview?.classList.add('hidden');
    this._replay?.classList.remove('hidden');
    return { realDuration };
  }

  getCurrentTime() {
    if (!this._active || !this._clock) return 0;
    if (this._mode === 'review' && this._replayEngine?.element) {
      return this._replayEngine.element.currentTime || 0;
    }
    return this._clock.now();
  }

  getDuration() {
    if (!this._active || !this._clock) return 0;
    if (this._mode === 'review' && this._replayEngine?.element) {
      const d = this._replayEngine.element.duration;
      return Number.isFinite(d) ? d : 0;
    }
    const n = this._clock.now();
    return n > 0 ? n + 0.5 : 0;
  }

  seekTo(seconds) {
    if (!this._active) return;
    if (this._mode === 'review' && this._replayEngine?.element) {
      try {
        this._replayEngine.element.currentTime = Math.max(0, seconds);
      } catch {
        /* noop */
      }
    }
  }

  play() {
    if (!this._active) return;
    if (this._mode === 'review' && this._replayEngine?.element) {
      this._replayEngine.element.play().catch(() => {});
      this.isPlaying = true;
    }
  }

  pause() {
    if (!this._active) return;
    if (this._mode === 'review' && this._replayEngine?.element) {
      this._replayEngine.element.pause();
      this.isPlaying = false;
    }
  }

  setPlaybackRate() {
    /* sin audio / velocidad en v1 live */
  }

  getVolume() {
    return 100;
  }

  setVolume() {}

  isMuted() {
    return true;
  }

  mute() {}

  unMute() {}

  async playbackSilenced(fn) {
    this._playbackSilenced = true;
    try {
      return await fn();
    } finally {
      this._playbackSilenced = false;
    }
  }

  /** YouTube Live detection no aplica. */
  isYoutubeLive() {
    return false;
  }

  /** “Volver al vivo” en captura propia = goLive(). */
  jumpToLiveEdge() {
    this.goLive();
  }

  _showLiveSurfaces() {
    this._youtubeSlot?.classList.add('hidden');
    this._replay?.classList.add('hidden');
    this._preview?.classList.remove('hidden');
  }

  _hideLiveSurfaces() {
    this._youtubeSlot?.classList.remove('hidden');
    this._preview?.classList.add('hidden');
    this._replay?.classList.add('hidden');
  }
}
