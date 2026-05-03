/**
 * Orquesta CaptureSession + RollingRecorder + SegmentStore + SessionClock (vía facade).
 * Una sola grabación activa globalmente (MVP).
 */

import {
  DEFAULT_CODEC,
  DEFAULT_TIMESLICE_MS,
  VIDEO_SOURCE_LIVE_CAPTURE,
} from './constants.js';
import { detectSupportedMimeTypes } from './codecs.js';
import { CaptureSession, buildVideoConstraints } from './CaptureSession.js';
import { RollingRecorder } from './RollingRecorder.js';
import { SegmentStore } from './SegmentStore.js';
import { ManifestStore } from './ManifestStore.js';
import { buildBlobFromSessionParts } from './sessionConsolidate.js';

/** @type {LiveRecordingHandle|null} */
let _active = null;

/** Vista previa sin grabar: mismo MediaStream que se reutiliza al iniciar REC. */
/** @type {{ facade: import('./LiveCaptureFacade.js').LiveCaptureFacade, capture: import('./CaptureSession.js').CaptureSession }|null} */
let _preview = null;

/** Metadatos de la última sesión detenida (para consolidar / promoción local). */
/** @type {import('./sessionConsolidate.js').StoppedSessionMeta & { segmentCount?: number, totalBytes?: number }|null} */
let _lastStoppedSession = null;

function pickMimeType(preferred) {
  if (preferred && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(preferred)) {
    return preferred;
  }
  const list = typeof MediaRecorder !== 'undefined' ? detectSupportedMimeTypes() : [];
  if (list.includes(DEFAULT_CODEC)) return DEFAULT_CODEC;
  if (list.length > 0) return list[0];
  return 'video/webm';
}

/**
 * @typedef {object} LiveRecordingHandle
 * @property {string} sessionId
 * @property {() => Promise<{ sessionId: string, segmentCount: number, totalBytes: number, elapsedSec: number }>}
 */

/**
 * @param {object} opts
 * @param {import('./LiveCaptureFacade.js').LiveCaptureFacade} opts.facade
 * @param {string} [opts.sessionId] — si omitís, usa facade.getSessionId()
 * @param {string} [opts.deviceId]
 * @param {'720'|'1080'|'any'} [opts.resolution]
 * @param {string} [opts.mimeType]
 * @param {number} [opts.timesliceMs]
 * @returns {Promise<LiveRecordingHandle>}
 */
/**
 * Vista previa de cámara en el video (sin MediaRecorder).
 * @param {object} opts
 * @param {import('./LiveCaptureFacade.js').LiveCaptureFacade} opts.facade
 * @param {string} [opts.deviceId]
 * @param {'720'|'1080'|'any'} [opts.resolution]
 */
export async function startLivePreview(opts) {
  const { facade, deviceId, resolution = '720' } = opts;
  if (_active) return;
  if (!facade || typeof facade.isActive !== 'function' || !facade.isActive()) {
    throw new Error('LiveCaptureFacade no está activo.');
  }

  const resNorm = resolution === '1080' || resolution === 'any' || resolution === '720' ? resolution : '720';
  stopLivePreview();
  const capture = new CaptureSession(buildVideoConstraints({ deviceId, resolution: resNorm }));
  const stream = await capture.open();
  facade.attachPreviewStream(stream);
  _preview = { facade, capture };
}

export function stopLivePreview() {
  if (!_preview) return;
  try {
    _preview.capture.close();
  } catch {
    /* noop */
  }
  try {
    _preview.facade.attachPreviewStream(null);
  } catch {
    /* noop */
  }
  _preview = null;
}

export function isLivePreviewActive() {
  return _preview != null && !!_preview.capture.getStream();
}

export async function startLiveRecording(opts) {
  if (_active) {
    throw new Error('Ya hay una grabación activa. Llamá stopLiveRecording() antes.');
  }
  const { facade, deviceId, resolution = '720', mimeType, timesliceMs = DEFAULT_TIMESLICE_MS } = opts;
  let { sessionId } = opts;

  if (!facade || typeof facade.isActive !== 'function' || !facade.isActive()) {
    throw new Error('LiveCaptureFacade no está activo. Entrá con enterLiveCapture(sessionId) o loadLiveCapture primero.');
  }

  sessionId = sessionId || facade.getSessionId();
  if (!sessionId) {
    throw new Error('Falta sessionId en la facade. Usá enterLiveCapture("mi-sesion").');
  }

  const resNorm = resolution === '1080' || resolution === 'any' || resolution === '720' ? resolution : '720';

  let capture;
  let stream;
  const reusePreview = _preview && _preview.facade === facade && _preview.capture.getStream();
  if (reusePreview) {
    capture = _preview.capture;
    stream = capture.getStream();
    _preview = null;
    if (!stream) {
      throw new Error('La vista previa no tiene stream; elegí la cámara de nuevo.');
    }
  } else {
    stopLivePreview();
    capture = new CaptureSession(buildVideoConstraints({ deviceId, resolution: resNorm }));
    stream = await capture.open();
    facade.attachPreviewStream(stream);
  }

  let opfsWriter = null;
  try {
    opfsWriter = await SegmentStore.openSession(sessionId);
  } catch (e) {
    console.warn('[LiveCapture] OPFS no disponible, segmentos solo en memoria:', e?.message || e);
  }

  const memoryChunks = [];
  let segmentCount = 0;
  let totalBytes = 0;

  const chosenMime = pickMimeType(mimeType);

  const clock = facade.getSessionClock();
  if (!clock) throw new Error('SessionClock no inicializado en la facade');

  const rolling = new RollingRecorder(stream, {
    mimeType: chosenMime,
    timesliceMs,
    sessionClock: clock,
    onChunk: async (blob, meta) => {
      segmentCount += 1;
      totalBytes += blob.size;
      if (opfsWriter) {
        try {
          await opfsWriter.writeSegment(meta.index, blob);
        } catch (err) {
          console.warn('[LiveCapture] Escritura OPFS falló, chunk a memoria:', err?.message || err);
          memoryChunks.push(blob);
        }
      } else {
        memoryChunks.push(blob);
      }
    },
  });

  try {
    await ManifestStore.put({
      sessionId,
      status: 'recording',
      videoSource: VIDEO_SOURCE_LIVE_CAPTURE,
      mimeType: chosenMime,
      timesliceMs,
      segmentCount: 0,
      totalBytes: 0,
    });
  } catch (e) {
    console.warn('[LiveCapture] ManifestStore.put:', e?.message || e);
  }

  rolling.start();

  const handle = {
    sessionId,
    captureSession: capture,
    rollingRecorder: rolling,
    opfsWriter,
    memoryChunks,
    facade,
    mimeType: chosenMime,

    async stop() {
      await rolling.stop();
      capture.close();
      facade.attachPreviewStream(null);

      try {
        await ManifestStore.put({
          sessionId,
          status: 'stopped',
          videoSource: VIDEO_SOURCE_LIVE_CAPTURE,
          mimeType: chosenMime,
          timesliceMs,
          segmentCount,
          totalBytes,
          durationSec: clock.elapsedSec(),
        });
      } catch (e) {
        console.warn('[LiveCapture] ManifestStore fin:', e?.message || e);
      }

      const elapsedSec = clock.elapsedSec();

      _lastStoppedSession = {
        sessionId,
        memoryChunks: [...memoryChunks],
        mimeType: chosenMime,
        segmentCount,
        totalBytes,
      };

      _active = null;

      return {
        sessionId,
        segmentCount,
        totalBytes,
        elapsedSec,
      };
    },
  };

  _active = handle;
  return handle;
}

/**
 * @returns {Promise<{ sessionId: string, segmentCount: number, totalBytes: number, elapsedSec: number }|null>}
 */
export async function stopLiveRecording() {
  if (!_active) return null;
  const out = await _active.stop();
  return out;
}

export function pauseLiveRecording() {
  if (!_active?.rollingRecorder) return;
  _active.rollingRecorder.pause();
}

export function resumeLiveRecording() {
  if (!_active?.rollingRecorder) return;
  _active.rollingRecorder.resume();
}

/** MediaRecorder en estado paused (relacionado con pauseLiveRecording). */
export function isLiveRecordingPaused() {
  return _active?.rollingRecorder?.state === 'paused';
}

/** Grabación en curso (misma referencia que devolvió startLiveRecording). */
export function getActiveLiveRecording() {
  return _active;
}

/** Hay MediaRecorder activo. */
export function isLiveRecordingActive() {
  return _active != null;
}

/**
 * Lista dispositivos videoinput (labels útiles tras permiso de cámara).
 * @returns {Promise<MediaDeviceInfo[]>}
 */
export async function listVideoInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

/** Última grabación detenida con `stopLiveRecording` (misma ventana). */
export function getLastStoppedSession() {
  return _lastStoppedSession;
}

/**
 * Snapshot DVR: consolida segmentos hasta ahora y entra en modo revisión (grabación sigue).
 * @param {import('./LiveCaptureFacade.js').LiveCaptureFacade} facade
 */
export async function snapshotReview(facade) {
  const act = getActiveLiveRecording();
  if (!act) {
    throw new Error('No hay grabación activa.');
  }
  if (!facade || typeof facade.enterReviewWithBlob !== 'function') {
    throw new Error('Falta LiveCaptureFacade.');
  }
  const blob = await buildBlobFromSessionParts(act.sessionId, act.memoryChunks, act.mimeType);
  return facade.enterReviewWithBlob(blob);
}
