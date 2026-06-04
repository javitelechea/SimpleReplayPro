/**
 * Fachada del reproductor para videoSource `liveCapture`.
 * No usa VideoPlayer ni #youtube-player; usa #live-preview-video y #live-replay-video.
 *
 * Fase 2: contrato compatible con lo que delega YTPlayer; captura real en Fase 3+.
 */

import { SessionClock } from './SessionClock.js';
import { ReplayEngine } from './ReplayEngine.js';

export const LIVE_CAPTURE_ENGINE_TYPE = 'liveCapture';

const HTTPS_LOCAL_STREAM_MSG =
  'Desde HTTPS (simplereplay.survision.ar) el navegador bloquea MediaMTX en http://127.0.0.1. ' +
  'Usá la app en http://127.0.0.1:8080 en esta misma PC, o poné HTTPS en MediaMTX.';

/** Página HTTPS no puede cargar streams HTTP a localhost/IP local (mixed content). */
export function isHttpsPageBlockedLocalMediaUrl(anyUrl) {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return false;
  try {
    const u = new URL(String(anyUrl || '').trim());
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

export function getHttpsLocalStreamBlockedMessage() {
  return HTTPS_LOCAL_STREAM_MSG;
}

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
    if (!/^(rtsp|https?):\/\//i.test(src)) {
      throw new Error('Usá una URL RTSP o HTTP de MediaMTX (ej. http://localhost:8888/tapo/).');
    }
    if (isHttpsPageBlockedLocalMediaUrl(src)) {
      throw new Error(HTTPS_LOCAL_STREAM_MSG);
    }
    const endpoints = this._buildIpReadEndpoints(src);
    for (const endpoint of endpoints) {
      if (isHttpsPageBlockedLocalMediaUrl(endpoint)) {
        throw new Error(HTTPS_LOCAL_STREAM_MSG);
      }
    }
    let lastErr = null;
    for (const endpoint of endpoints) {
      if (/\.m3u8(\?|#|$)/i.test(endpoint)) {
        try {
          await this._attachPreviewMediamtxHls(endpoint);
          return;
        } catch (e) {
          lastErr = e;
          continue;
        }
      }
      if (/\/whep$/i.test(endpoint)) {
        try {
          await this._attachPreviewWebRtcOnce(endpoint);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    const hint = lastErr?.message || 'sin detalle';
    throw new Error(`No se pudo abrir la cámara IP (${hint}). Probá http://127.0.0.1:8888/tapo/ con MediaMTX activo.`);
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
    this._preview.onplay = null;
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

  /**
   * Orden baja latencia: WHEP (:8889) primero, luego HLS LL (:8888).
   * Alineado con la página de MediaMTX (http://host:8888/path/).
   */
  _buildIpReadEndpoints(url) {
    const src = String(url || '').trim();
    if (/^rtsp:\/\//i.test(src)) return this._buildRtspReadEndpoints(src);
    if (/^https?:\/\//i.test(src)) return this._buildHttpReadEndpoints(src);
    return [];
  }

  _buildRtspReadEndpoints(rtspUrl) {
    const parsed = this._parseStreamPathUrl(rtspUrl);
    if (!parsed) return [];
    return this._mediamtxReadUrls(parsed.host, parsed.path);
  }

  _buildHttpReadEndpoints(httpUrl) {
    const parsed = this._parseStreamPathUrl(httpUrl);
    if (!parsed) return [];
    const out = this._mediamtxReadUrls(parsed.host, parsed.path);
    const clean = httpUrl.replace(/\/+$/, '');
    if (/\.m3u8(\?|#|$)/i.test(clean)) out.unshift(clean);
    return [...new Set(out)];
  }

  _mediamtxReadUrls(host, path) {
    const h = this._normalizeStreamHost(host);
    const p = path || 'cam';
    // Mismo orden que la página http://host:8888/path/ de MediaMTX (HLS primero).
    return [
      `http://${h}:8888/${p}/index.m3u8`,
      `http://${h}:8889/${p}/whep`,
    ];
  }

  /** Mismo host que la app (127.0.0.1 vs localhost) para evitar CORS y fallos raros. */
  _normalizeStreamHost(host) {
    const h = String(host || '').toLowerCase();
    const bracketed = h.includes(':') ? `[${host}]` : host;
    const isLoopback = h === 'localhost' || h === '127.0.0.1' || h === '::1';
    if (!isLoopback) return bracketed;
    const pageHost =
      typeof window !== 'undefined' && window.location?.hostname
        ? window.location.hostname
        : '127.0.0.1';
    const use = pageHost.toLowerCase() === 'localhost' ? 'localhost' : '127.0.0.1';
    return use;
  }

  _parseStreamPathUrl(anyUrl) {
    try {
      const u = new URL(anyUrl);
      const path = (u.pathname || '/').replace(/^\/+/, '').replace(/\/index\.m3u8$/i, '') || 'cam';
      return { host: u.hostname, path };
    } catch {
      return null;
    }
  }

  /** Igual que internal/servers/hls/index.html de MediaMTX. */
  _hlsMediamtxOptions() {
    return { maxLiveSyncPlaybackRate: 1.5 };
  }

  /**
   * HLS como en http://127.0.0.1:8888/tapo/ (hls.min.js del propio MediaMTX).
   * @param {string} m3u8Url
   */
  async _attachPreviewMediamtxHls(m3u8Url) {
    if (!this._preview) throw new Error('Preview no disponible.');
    this._clearPreviewSurface();
    const u = new URL(m3u8Url);
    const HlsCtor = await this._loadHlsCtor(u.hostname, u.port || '8888');
    if (!(HlsCtor && HlsCtor.isSupported())) {
      throw new Error('HLS no soportado en este navegador.');
    }

    this._preview.crossOrigin = 'anonymous';
    this._preview.playsInline = true;
    this._preview.muted = true;
    this._preview.autoplay = true;

    const hls = new HlsCtor(this._hlsMediamtxOptions());
    this._hls = hls;

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        try { hls.off(HlsCtor.Events.ERROR, onErr); } catch { /* noop */ }
        try { hls.off(HlsCtor.Events.MANIFEST_LOADED, onManifest); } catch { /* noop */ }
        try { hls.off(HlsCtor.Events.MEDIA_ATTACHED, onAttached); } catch { /* noop */ }
        if (ok) resolve();
        else reject(err || new Error('No se pudo cargar HLS.'));
      };
      const onErr = (_evt, data) => {
        if (data?.fatal) done(false, new Error(`HLS: ${data.type || 'fatal'}`));
      };
      const onManifest = () => {
        try { this._preview.play().catch(() => {}); } catch { /* noop */ }
        done(true);
      };
      const onAttached = () => {
        hls.loadSource(m3u8Url);
      };
      hls.on(HlsCtor.Events.ERROR, onErr);
      hls.on(HlsCtor.Events.MANIFEST_LOADED, onManifest);
      hls.on(HlsCtor.Events.MEDIA_ATTACHED, onAttached);
      hls.attachMedia(this._preview);
      setTimeout(() => done(false, new Error('Timeout cargando HLS.')), 12000);
    });

    this._preview.onplay = () => {
      try {
        const pos = hls.liveSyncPosition;
        if (Number.isFinite(pos) && pos > 0) {
          this._preview.currentTime = pos;
        }
      } catch {
        /* noop */
      }
    };
    try { await this._preview.play(); } catch { /* noop */ }
  }

  _isLocalHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  async _attachPreviewUrlOnce(src) {
    if (!this._preview) throw new Error('Preview no disponible.');
    const isM3u8 = /\.m3u8(\?|#|$)/i.test(src);
    if (!isM3u8 && /^https?:\/\//i.test(src)) {
      const candidates = this._buildUrlCandidates(src).filter((u) => /\.m3u8(\?|#|$)/i.test(u));
      let lastErr = null;
      for (const m3u8 of candidates) {
        try {
          await this._attachPreviewUrlOnce(m3u8);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('La URL HTTP no es un stream de video (usá …/index.m3u8 o la página MediaMTX /tapo/).');
    }
    this._clearPreviewSurface();
    const canNativeHls = this._preview.canPlayType('application/vnd.apple.mpegurl');
    this._preview.crossOrigin = 'anonymous';
    this._preview.playsInline = true;
    this._preview.muted = true;
    this._preview.autoplay = true;

    const loadTimeoutMs = 6000;

    if (isM3u8) {
      if (canNativeHls) {
        try {
          await this._attachPreviewVideoSrcOnce(src, loadTimeoutMs);
          try { await this._preview.play(); } catch { /* noop */ }
          return;
        } catch {
          /* fallback hls.js */
        }
      }
      const HlsCtor = await this._loadHlsCtor();
      if (!(HlsCtor && HlsCtor.isSupported())) {
        throw new Error('HLS no soportado en este navegador.');
      }
      this._hls = new HlsCtor(this._hlsMediamtxOptions());
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
        const onParsed = () => {
          try {
            const edge = this._hls?.liveSyncPosition;
            if (Number.isFinite(edge) && edge > 0) {
              this._preview.currentTime = edge;
            }
          } catch {
            /* noop */
          }
          done(true);
        };
        const onErr = (_evt, data) => {
          if (data?.fatal) {
            done(false, new Error(`HLS error: ${data.type || 'fatal'}`));
          }
        };
        this._hls.on(HlsCtor.Events.MANIFEST_PARSED, onParsed);
        this._hls.on(HlsCtor.Events.ERROR, onErr);
        this._hls.loadSource(src);
        this._hls.attachMedia(this._preview);
        setTimeout(() => done(false, new Error('Timeout cargando HLS.')), loadTimeoutMs);
      });
      try { await this._preview.play(); } catch { /* noop */ }
      return;
    }

    await this._attachPreviewVideoSrcOnce(src, loadTimeoutMs);
    try { await this._preview.play(); } catch { /* noop */ }
  }

  _attachPreviewVideoSrcOnce(src, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
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
      setTimeout(() => done(false, new Error('Timeout cargando stream URL.')), timeoutMs);
    });
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
    let gotVideo = false;
    const bindTrack = (ev) => {
      ev.streams.forEach((s) => s.getTracks().forEach((t) => ms.addTrack(t)));
      if (!ev.streams.length && ev.track) ms.addTrack(ev.track);
      if (!ms.getVideoTracks().length) return;
      gotVideo = true;
      this._preview.srcObject = ms;
      this._preview.play().catch(() => {});
    };
    pc.ontrack = bindTrack;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    let host = '';
    try {
      host = new URL(endpoint).hostname;
    } catch {
      /* noop */
    }
    const iceMs = this._isLocalHost(host) ? 800 : 2500;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitIceGatheringComplete(pc, iceMs);
    const sdpOffer = pc.localDescription?.sdp || offer.sdp || '';
    if (!sdpOffer) throw new Error('No se pudo crear oferta WebRTC.');

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: sdpOffer,
      });
    } catch (e) {
      throw new Error(`WebRTC bloqueado (CORS/red): ${e?.message || e}`);
    }
    if (!res.ok) throw new Error(`WebRTC no disponible (${res.status}).`);
    const answerSdp = await res.text();
    if (!answerSdp || !answerSdp.includes('m=')) {
      throw new Error('Respuesta WebRTC inválida.');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    const loc = res.headers.get('location') || '';
    this._whepResourceUrl = loc ? new URL(loc, endpoint).toString() : '';

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (gotVideo) resolve();
        else reject(new Error('WebRTC sin video (¿MediaMTX activo y stream en el path?)'));
      }, 8000);
      const check = () => {
        if (gotVideo) {
          clearTimeout(t);
          resolve();
        }
      };
      pc.addEventListener('track', () => check());
      check();
    });
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

  /**
   * @param {string} [mtxHost]
   * @param {string} [mtxPort]
   */
  async _loadHlsCtor(mtxHost, mtxPort = '8888') {
    if (typeof window === 'undefined') return null;
    if (window.Hls) return window.Hls;

    const h = this._normalizeStreamHost(mtxHost || '127.0.0.1');
    const scriptUrl = `http://${h}:${mtxPort}/hls.min.js`;
    if (isHttpsPageBlockedLocalMediaUrl(scriptUrl)) {
      throw new Error(HTTPS_LOCAL_STREAM_MSG);
    }
    const cacheKey = `__srHlsLoad:${scriptUrl}`;

    if (window[cacheKey]) {
      await window[cacheKey];
      return window.Hls || null;
    }

    window[cacheKey] = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = scriptUrl;
      tag.async = true;
      tag.onload = () => resolve();
      tag.onerror = () => {
        const fallback = document.createElement('script');
        fallback.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7';
        fallback.async = true;
        fallback.onload = () => resolve();
        fallback.onerror = () => reject(new Error('No se pudo cargar hls.js'));
        document.head.appendChild(fallback);
      };
      document.head.appendChild(tag);
    });
    await window[cacheKey];
    return window.Hls || null;
  }
}
