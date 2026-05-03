/**
 * Reloj de sesión monotónico para tags y segmentos (eje temporal común).
 * Usa performance.now(); no depende de currentTime del video de preview.
 */
export class SessionClock {
  constructor() {
    /** @type {number|null} */
    this._t0 = null;
    /** @type {number|null} */
    this._t1 = null;
    /** @type {number|null} */
    this._pauseStarted = null;
    /** @type {number} */
    this._totalPausedMs = 0;
  }

  /** Inicia el reloj (al arrancar MediaRecorder). */
  start() {
    this._t0 = performance.now();
    this._t1 = null;
    this._pauseStarted = null;
    this._totalPausedMs = 0;
  }

  /** Congela el tiempo de sesión al detener la grabación (después del último chunk). */
  markStopped() {
    if (this._t0 == null) return;
    if (this._pauseStarted != null) {
      this._totalPausedMs += performance.now() - this._pauseStarted;
      this._pauseStarted = null;
    }
    this._t1 = performance.now();
  }

  reset() {
    this._t0 = null;
    this._t1 = null;
    this._pauseStarted = null;
    this._totalPausedMs = 0;
  }

  isRunning() {
    return this._t0 != null && this._t1 == null;
  }

  /** Pausa el cómputo de tiempo (alinear con MediaRecorder.pause). */
  pause() {
    if (this._t0 == null || this._t1 != null || this._pauseStarted != null) return;
    this._pauseStarted = performance.now();
  }

  resume() {
    if (this._pauseStarted == null) return;
    this._totalPausedMs += performance.now() - this._pauseStarted;
    this._pauseStarted = null;
  }

  isPaused() {
    return this._pauseStarted != null;
  }

  /**
   * Segundos desde el inicio de sesión.
   * Durante grabación: tiempo en vivo.
   * Tras markStopped: valor congelado (duración de sesión).
   */
  now() {
    if (this._t0 == null) return 0;
    const end =
      this._t1 != null
        ? this._t1
        : this._pauseStarted != null
          ? this._pauseStarted
          : performance.now();
    return (end - this._t0 - this._totalPausedMs) / 1000;
  }

  /** Igual que now() tras markStopped; alias para lectura clara. */
  elapsedSec() {
    return this.now();
  }
}
