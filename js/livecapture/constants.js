/**
 * LiveCapture — valores compartidos (Fase 1).
 * videoSource en datos del game ≠ YouTube Live ("youtube") ni archivo ("local").
 */
export const VIDEO_SOURCE_LIVE_CAPTURE = 'liveCapture';

/** Codec por defecto acordado para v1 (Chrome/Chromium). */
export const DEFAULT_CODEC = 'video/webm;codecs=vp9';

/** Timeslice por defecto del MediaRecorder (ms). */
export const DEFAULT_TIMESLICE_MS = 4000;

/** Carpeta raíz bajo OPFS del origin. */
export const OPFS_LIVECAPTURE_ROOT = 'livecapture';

/** Nombre del archivo consolidado dentro de cada sesión OPFS. */
export const OPFS_FINAL_FILENAME = 'final.webm';
