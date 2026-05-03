import { OPFS_FINAL_FILENAME, OPFS_LIVECAPTURE_ROOT } from './constants.js';

function assertOpfs() {
  if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('OPFS no disponible en este entorno');
  }
}

/**
 * Segmentación en OPFS: /livecapture/<sessionId>/seg-000000.webm …
 */
export const SegmentStore = {
  assertOpfs,

  /**
   * Abre (crea) el directorio de sesión y devuelve handles para escritura.
   * @param {string} sessionId
   */
  async openSession(sessionId) {
    assertOpfs();
    const root = await navigator.storage.getDirectory();
    const lc = await root.getDirectoryHandle(OPFS_LIVECAPTURE_ROOT, { create: true });
    const dir = await lc.getDirectoryHandle(sessionId, { create: true });
    return {
      sessionId,
      dirHandle: dir,
      /**
       * @param {number} index
       * @param {Blob} blob
       */
      async writeSegment(index, blob) {
        const name = `seg-${String(index).padStart(6, '0')}.webm`;
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        return name;
      },
    };
  },

  /**
   * Lee todos los segmentos de una sesión, ordenados por nombre.
   * @param {string} sessionId
   * @returns {Promise<File[]>}
   */
  async readSegmentFiles(sessionId) {
    assertOpfs();
    const root = await navigator.storage.getDirectory();
    let lc;
    try {
      lc = await root.getDirectoryHandle(OPFS_LIVECAPTURE_ROOT);
    } catch {
      return [];
    }
    let dir;
    try {
      dir = await lc.getDirectoryHandle(sessionId);
    } catch {
      return [];
    }
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && name.startsWith('seg-') && name.endsWith('.webm')) {
        const file = await handle.getFile();
        out.push({ name, file });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.map((o) => o.file);
  },

  /**
   * Escribe el archivo final consolidado en la carpeta de sesión.
   * @param {string} sessionId
   * @param {Blob} blob
   */
  async writeFinal(sessionId, blob) {
    assertOpfs();
    const root = await navigator.storage.getDirectory();
    const lc = await root.getDirectoryHandle(OPFS_LIVECAPTURE_ROOT, { create: true });
    const dir = await lc.getDirectoryHandle(sessionId, { create: true });
    const fh = await dir.getFileHandle(OPFS_FINAL_FILENAME, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  },

  /**
   * Lee el archivo final si existe.
   * @param {string} sessionId
   * @returns {Promise<File|null>}
   */
  async readFinal(sessionId) {
    assertOpfs();
    try {
      const root = await navigator.storage.getDirectory();
      const lc = await root.getDirectoryHandle(OPFS_LIVECAPTURE_ROOT);
      const dir = await lc.getDirectoryHandle(sessionId);
      const fh = await dir.getFileHandle(OPFS_FINAL_FILENAME);
      return await fh.getFile();
    } catch {
      return null;
    }
  },

  /**
   * Elimina toda la carpeta de sesión en OPFS.
   * @param {string} sessionId
   */
  async deleteSession(sessionId) {
    assertOpfs();
    try {
      const root = await navigator.storage.getDirectory();
      const lc = await root.getDirectoryHandle(OPFS_LIVECAPTURE_ROOT);
      await lc.removeEntry(sessionId, { recursive: true });
    } catch {
      /* noop */
    }
  },

  /** @returns {Promise<{ quota: number, usage: number }|null>} */
  async estimate() {
    try {
      return await navigator.storage.estimate();
    } catch {
      return null;
    }
  },
};
