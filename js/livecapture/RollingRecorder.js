import { DEFAULT_TIMESLICE_MS } from './constants.js';

/**
 * MediaRecorder con timeslice + reloj de sesión alineado al evento `start`.
 */
export class RollingRecorder {
  /**
   * @param {MediaStream} mediaStream
   * @param {object} options
   * @param {string} options.mimeType
   * @param {number} [options.timesliceMs]
   * @param {import('./SessionClock.js').SessionClock|null} [options.sessionClock]
   * @param {(blob: Blob, meta: { index: number, tArrivalSec: number, mimeType: string }) => void} [options.onChunk]
   */
  constructor(mediaStream, options) {
    this._stream = mediaStream;
    this._mimeType = options.mimeType;
    this._timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this._clock = options.sessionClock ?? null;
    this._onChunk = options.onChunk;
    /** @type {MediaRecorder|null} */
    this._recorder = null;
    this._segmentIndex = 0;
  }

  /**
   * @returns {'inactive'|'recording'|'paused'}
   */
  get state() {
    return this._recorder?.state ?? 'inactive';
  }

  start() {
    if (this._recorder && this._recorder.state !== 'inactive') return;

    this._segmentIndex = 0;
    this._recorder = new MediaRecorder(this._stream, { mimeType: this._mimeType });

    this._recorder.addEventListener('dataavailable', (e) => {
      if (!e.data || e.data.size === 0) return;
      const blob = e.data;
      const tArrivalSec = this._clock?.now() ?? 0;
      const meta = {
        index: this._segmentIndex++,
        tArrivalSec,
        mimeType: blob.type || this._mimeType,
      };
      try {
        this._onChunk?.(blob, meta);
      } catch (err) {
        console.warn('RollingRecorder onChunk', err);
      }
    });

    this._recorder.addEventListener('error', (e) => {
      console.warn('RollingRecorder error', e.error?.message || e);
    });

    // Alinear SessionClock con el MediaRecorder real (evita desync si pause()/resume() fallan o son async).
    this._recorder.addEventListener('pause', () => {
      try {
        if (this._clock && !this._clock.isPaused()) this._clock.pause();
      } catch {
        /* noop */
      }
    });
    this._recorder.addEventListener('resume', () => {
      try {
        if (this._clock && this._clock.isPaused()) this._clock.resume();
      } catch {
        /* noop */
      }
    });

    this._clock?.start();
    this._recorder.start(this._timesliceMs);
  }

  pause() {
    const rec = this._recorder;
    if (!rec || rec.state !== 'recording') return;
    try {
      rec.pause();
    } catch (e) {
      console.warn('RollingRecorder pause', e);
      return;
    }
    // Chrome a veces deja el estado en «recording» un instante; un segundo intento suele bastar.
    queueMicrotask(() => {
      const r = this._recorder;
      if (!r) return;
      if (r.state === 'recording') {
        try {
          r.pause();
        } catch {
          /* noop */
        }
      }
      if (r.state === 'paused' && this._clock && !this._clock.isPaused()) {
        this._clock.pause();
      }
    });
  }

  resume() {
    const rec = this._recorder;
    if (!rec || rec.state !== 'paused') return;
    try {
      rec.resume();
    } catch (e) {
      console.warn('RollingRecorder resume', e);
      return;
    }
    queueMicrotask(() => {
      const r = this._recorder;
      if (!r) return;
      if (r.state === 'paused') {
        try {
          r.resume();
        } catch {
          /* noop */
        }
      }
      if (r.state === 'recording' && this._clock && this._clock.isPaused()) {
        this._clock.resume();
      }
    });
  }

  /**
   * Espera al evento stop del recorder y congela el reloj de sesión.
   * @returns {Promise<void>}
   */
  async stop() {
    const rec = this._recorder;
    if (!rec || rec.state === 'inactive') {
      this._clock?.markStopped();
      return;
    }

    await new Promise((resolve) => {
      rec.addEventListener('stop', () => resolve(), { once: true });
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });

    this._clock?.markStopped();
    this._recorder = null;
  }
}
