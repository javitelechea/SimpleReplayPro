/**
 * Consolidación de segmentos OPFS + memoria → un Blob; escritura final.webm; promoción a reproductor local.
 */

import { SegmentStore } from './SegmentStore.js';
import { ManifestStore } from './ManifestStore.js';
import { VIDEO_SOURCE_LIVE_CAPTURE } from './constants.js';
import { concatenateSegments } from './Consolidator.js';

/**
 * Une segmentos en disco (orden por nombre) y, si hubo fallbacks a memoria, los agrega al final.
 * @param {string} sessionId
 * @param {Blob[]} memoryChunks — orden de llegada (fallback OPFS o solo-memoria)
 * @param {string} [mimeTypeHint]
 * @returns {Promise<Blob>}
 */
export async function buildBlobFromSessionParts(sessionId, memoryChunks, mimeTypeHint = 'video/webm') {
  const fromDisk = await SegmentStore.readSegmentFiles(sessionId);
  let parts = [];
  if (fromDisk.length > 0) {
    parts = memoryChunks?.length ? [...fromDisk, ...memoryChunks] : fromDisk;
  } else if (memoryChunks?.length) {
    parts = memoryChunks;
  }
  if (!parts.length) {
    throw new Error('Sin segmentos para consolidar (OPFS vacío y sin memoria).');
  }
  return concatenateSegments(parts, mimeTypeHint);
}

/**
 * @typedef {object} StoppedSessionMeta
 * @property {string} sessionId
 * @property {Blob[]} memoryChunks
 * @property {string} mimeType
 * @property {number} [segmentCount]
 * @property {number} [totalBytes]
 */

/**
 * @param {StoppedSessionMeta} meta
 * @returns {Promise<{ blob: Blob, file: File }>}
 */
export async function blobAndFileFromStoppedSession(meta) {
  const blob = await buildBlobFromSessionParts(meta.sessionId, meta.memoryChunks, meta.mimeType);
  const name = `livecapture-${meta.sessionId}.webm`;
  const file = new File([blob], name, { type: blob.type || meta.mimeType });
  return { blob, file };
}

/**
 * Escribe final.webm en OPFS y actualiza manifest (best-effort).
 * @param {string} sessionId
 * @param {Blob} blob
 */
export async function persistFinalAndManifest(sessionId, blob) {
  try {
    await SegmentStore.writeFinal(sessionId, blob);
  } catch (e) {
    console.warn('[LiveCapture] writeFinal:', e?.message || e);
  }
  try {
    await ManifestStore.put({
      sessionId,
      status: 'consolidated',
      videoSource: VIDEO_SOURCE_LIVE_CAPTURE,
      consolidatedAt: new Date().toISOString(),
      finalBytes: blob.size,
    });
  } catch (e) {
    console.warn('[LiveCapture] ManifestStore consolidated:', e?.message || e);
  }
}

/**
 * Consolida una sesión ya detenida y la carga como video local (sale de liveCapture vía YTPlayer).
 * @param {{ loadLocalVideo?: (url: string, file: File|null) => void }} ytPlayer
 * @param {StoppedSessionMeta} meta
 * @param {{ download?: boolean }} [opts]
 * @returns {Promise<{ sessionId: string, blob: Blob, file: File, objectUrl: string }|null>}
 */
export async function promoteStoppedSessionToLocal(ytPlayer, meta, opts = {}) {
  if (!meta?.sessionId) return null;
  const { blob, file } = await blobAndFileFromStoppedSession(meta);
  await persistFinalAndManifest(meta.sessionId, blob);

  const objectUrl = URL.createObjectURL(blob);
  if (typeof ytPlayer?.loadLocalVideo === 'function') {
    ytPlayer.loadLocalVideo(objectUrl, file);
  }

  if (opts.download && typeof document !== 'undefined') {
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = file.name;
      a.rel = 'noopener';
      a.click();
    } catch {
      /* noop */
    }
  }

  return { sessionId: meta.sessionId, blob, file, objectUrl };
}
