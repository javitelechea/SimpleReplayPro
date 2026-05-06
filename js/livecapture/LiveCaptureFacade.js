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
    this._hls = null;
    this._pc = null;
    this._whepResourceUrl = '';
    this._liveStartedAtMs = 0;
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
    this._liveStartedAtMs = 0;
    this.isPlaying = false;
    this._showLiveSurfaces();
  }

  /**
   * Sale de LiveCapture y restaura #youtube-player.
   */
  unload() {
    this._clearPreviewSurface();
    this._replayEngine?.unload();
    this._replayEngine = null;

    this._sessionId = null;
    this._active = false;
    this._mode = 'live';
    this.isPlaying = false;
    this._liveStartedAtMs = 0;
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

  markLiveStarted() {
    if (!this._active) return;
    if (!this._liveStartedAtMs) {
      this._liveStartedAtMs = Date.now();
    }
  }

  getPreviewCaptureStream() {
    const v = this._preview;
    if (!v) return null;
    const fn = v.captureStream || v.mozCaptureStream;
    if (typeof fn !== 'function') return null;
    try {
      return fn.call(v);
    } catch {
      return null;
    }
  }

  /**
   * Preview del vivo (MediaStream). Pasar `null` para apagar cámara y limpiar el elemento.
   * @param {MediaStream|null} stream
   */
  attachPreviewStream(stream) {
    if (!this._preview) return;
    if (!stream) {
      this._clearPreviewSurface();
      return;
    }
    this._clearPreviewSurface();
    this._preview.srcObject = stream;
  }

  async attachPreviewUrl(url) {
    if (!this._preview) return;
    const src = String(url || '').trim();
    if (!src) {
      this._clearPreviewSurface();
      return;
    }
    const candidates = this._buildUrlCandidates(src);
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        await this._attachPreviewUrlOnce(candidate);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No se pudo abrir la URL de stream.');
  }

  async attachPreviewWebRtc(url) {
    if (!this._preview) return;
    const src = String(url || '').trim();
    if (!src) {
      this._clearPreviewSurface();
      return;
    }
    const candidates = this._buildWebRtcCandidates(src);
    let lastErr = null;
    for (const endpoint of candidates) {
      try {
        await this._attachPreviewWebRtcOnce(endpoint);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No se pudo abrir la URL WebRTC.');
  }

  async attachPreviewIp(url) {
    const src = String(url || '').trim();
    if (!src) {
      this._clearPreviewSurface();
      return;
    }
    let lastErr = null;
    try {
      await this.attachPreviewWebRtc(src);
      return;
    } catch (e) {
      lastErr = e;
    }
    try {
      await this.attachPreviewUrl(src);
      return;
    } catch (e) {
      lastErr = e;
    }
    throw lastErr || new Error('No se pudo abrir la cámara IP.');
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
    // Mismo reloj de sesión que usa getCurrentTime(); pausa/resume quedan alineados.
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

  _clearPreviewSurface() {
    if (!this._preview) return;
    if (this._pc) {
      try { this._pc.close(); } catch { /* noop */ }
      this._pc = null;
    }
    this._whepResourceUrl = '';
    if (this._hls) {
      try { this._hls.destroy(); } catch { /* noop */ }
      this._hls = null;
    }
    if (this._preview.srcObject) {
      try {
        this._preview.srcObject.getTracks().forEach((t) => t.stop());
      } catch {
        /* noop */
      }
      this._preview.srcObject = null;
    }
    try { this._preview.pause(); } catch { /* noop */ }
    this._preview.removeAttribute('src');
    try { this._preview.load(); } catch { /* noop */ }
  }

  _buildUrlCandidates(src) {
    const out = [src];
    const noHash = src.split('#')[0];
    const noQuery = noHash.split('?')[0];
    const isM3u8 = /\.m3u8$/i.test(noQuery);
    if (!isM3u8 && /\/$/.test(noQuery)) {
      const base = src.replace(/\/+$/, '');
      out.push(`${base}/index.m3u8`);
      out.push(`${base}/live.m3u8`);
    }
    return [...new Set(out)];
  }

  _buildWebRtcCandidates(src) {
    const clean = src.replace(/\/+$/, '');
    const out = [clean];
    if (!/\/whep$/i.test(clean)) out.push(`${clean}/whep`);
    if (!/\/webrtc$/i.test(clean)) out.push(`${clean}/webrtc`);
    return [...new Set(out)];
  }

  async _attachPreviewUrlOnce(src) {
    if (!this._preview) throw new Error('Preview no disponible.');
    this._clearPreviewSurface();
    const isM3u8 = /\.m3u8(\?|#|$)/i.test(src);
    const canNativeHls = this._preview.canPlayType('application/vnd.apple.mpegurl');
    this._preview.crossOrigin = 'anonymous';
    this._preview.playsInline = true;
    this._preview.muted = true;
    this._preview.autoplay = true;

    if (isM3u8 && !canNativeHls) {
      const HlsCtor = await this._loadHlsCtor();
      if (!(HlsCtor && HlsCtor.isSupported())) {
        throw new Error('HLS no soportado en este navegador.');
      }
      this._hls = new HlsCtor({
        lowLatencyMode: true,
        enableWorker: true,
        backBufferLength: 60,
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (ok, err) => {
          if (settled) return;
          settled = true;
          try { this._hls.off(HlsCtor.Events.MANIFEST_PARSED, onParsed); } catch { /* noop */ }
          try { this._hls.off(HlsCtor.Events.ERROR, onErr); } catch { /* noop */ }
          if (ok) resolve();
          else reject(err || new Error('No se pudo cargar el manifiesto HLS.'));
        };
        const onParsed = () => done(true);
        const onErr = (_evt, data) => {
          if (data?.fatal) {
            done(false, new Error(`HLS error: ${data.type || 'fatal'}`));
          }
        };
        this._hls.on(HlsCtor.Events.MANIFEST_PARSED, onParsed);
        this._hls.on(HlsCtor.Events.ERROR, onErr);
        this._hls.loadSource(src);
        this._hls.attachMedia(this._preview);
        setTimeout(() => done(false, new Error('Timeout cargando HLS.')), 9000);
      });
      try { await this._preview.play(); } catch { /* noop */ }
      return;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        this._preview.removeEventListener('loadedmetadata', onLoaded);
        this._preview.removeEventListener('error', onError);
        if (ok) resolve();
        else reject(err || new Error('No se pudo cargar el stream.'));
      };
      const onLoaded = () => done(true);
      const onError = () => done(false, new Error('URL no reproducible en este navegador.'));
      this._preview.addEventListener('loadedmetadata', onLoaded);
      this._preview.addEventListener('error', onError);
      this._preview.src = src;
      try { this._preview.load(); } catch { /* noop */ }
      setTimeout(() => done(false, new Error('Timeout cargando stream URL.')), 9000);
    });
    try { await this._preview.play(); } catch { /* noop */ }
  }

  async _attachPreviewWebRtcOnce(endpoint) {
    if (!this._preview) throw new Error('Preview no disponible.');
    this._clearPreviewSurface();
    this._preview.playsInline = true;
    this._preview.muted = true;
    this._preview.autoplay = true;

    const pc = new RTCPeerConnection({ iceServers: [] });
    this._pc = pc;
    const ms = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams.forEach((s) => s.getTracks().forEach((t) => ms.addTrack(t)));
      if (!ev.streams.length && ev.track) ms.addTrack(ev.track);
      this._preview.srcObject = ms;
      this._preview.play().catch(() => {});
    };
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitIceGatheringComplete(pc, 3000);
    const sdpOffer = pc.localDescription?.sdp || offer.sdp || '';
    if (!sdpOffer) throw new Error('No se pudo crear oferta WebRTC.');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdpOffer,
    });
    if (!res.ok) throw new Error(`WebRTC no disponible (${res.status}).`);
    const answerSdp = await res.text();
    if (!answerSdp || !answerSdp.includes('m=')) {
      throw new Error('Respuesta WebRTC inválida.');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    const loc = res.headers.get('location') || '';
    this._whepResourceUrl = loc ? new URL(loc, endpoint).toString() : '';
  }

  _waitIceGatheringComplete(pc, timeoutMs = 3000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const onState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', onState);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onState);
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }, timeoutMs);
    });
  }

  async _loadHlsCtor() {
    if (typeof window === 'undefined') return null;
    if (window.Hls) return window.Hls;
    if (window.__srHlsLoadPromise) {
      await window.__srHlsLoadPromise;
      return window.Hls || null;
    }
    window.__srHlsLoadPromise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
      tag.async = true;
      tag.onload = () => resolve();
      tag.onerror = () => reject(new Error('No se pudo cargar hls.js'));
      document.head.appendChild(tag);
    });
    await window.__srHlsLoadPromise;
    return window.Hls || null;
  }
}
