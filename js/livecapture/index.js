/**
 * LiveCapture — API pública del subsistema (Fase 1: módulos base).
 * La integración con YTPlayer / games llega en Fase 2+.
 */

export {
  VIDEO_SOURCE_LIVE_CAPTURE,
  DEFAULT_CODEC,
  DEFAULT_TIMESLICE_MS,
  OPFS_LIVECAPTURE_ROOT,
  OPFS_FINAL_FILENAME,
} from './constants.js';

export { SessionClock } from './SessionClock.js';
export { detectSupportedMimeTypes } from './codecs.js';
export { SegmentStore } from './SegmentStore.js';
export { ManifestStore } from './ManifestStore.js';
export { CaptureSession, buildVideoConstraints } from './CaptureSession.js';
export { RollingRecorder } from './RollingRecorder.js';
export { ReplayEngine, measureWebmDuration } from './ReplayEngine.js';
export { concatenateSegments } from './Consolidator.js';
export {
  buildBlobFromSessionParts,
  blobAndFileFromStoppedSession,
  persistFinalAndManifest,
  promoteStoppedSessionToLocal,
} from './sessionConsolidate.js';
export { LiveCaptureFacade, LIVE_CAPTURE_ENGINE_TYPE } from './LiveCaptureFacade.js';
export {
  startLiveRecording,
  startLivePreview,
  stopLivePreview,
  isLivePreviewActive,
  stopLiveRecording,
  pauseLiveRecording,
  resumeLiveRecording,
  isLiveRecordingPaused,
  getActiveLiveRecording,
  isLiveRecordingActive,
  listVideoInputs,
  getLastStoppedSession,
  snapshotReview,
} from './liveRecordingController.js';

/** APIs mínimas para grabación en vivo (Chrome/Chromium-first). */
export function canRunLiveCapture() {
  return !!(
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}
