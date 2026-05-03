import { VIDEO_SOURCE_LIVE_CAPTURE } from './constants.js';

const DB_NAME = 'simplereplay-livecapture-manifest-v1';
const STORE = 'sessions';
const DB_VERSION = 1;

/**
 * Metadata ligera por sesión (IndexedDB). Video y blobs pesados solo en OPFS.
 */
export const ManifestStore = {
  /** @returns {Promise<IDBDatabase>} */
  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'sessionId' });
        }
      };
    });
  },

  /**
   * @param {object} record
   * @param {string} record.sessionId
   * @param {string} [record.status]
   */
  async put(record) {
    const existing = await this.get(record.sessionId);
    const now = new Date().toISOString();
    const merged = {
      videoSource: VIDEO_SOURCE_LIVE_CAPTURE,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...existing,
      ...record,
    };
    const db = await this._open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await new Promise((res, rej) => {
      const r = store.put(merged);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    db.close();
  },

  /** @param {string} sessionId */
  async get(sessionId) {
    const db = await this._open();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const row = await new Promise((res, rej) => {
      const r = store.get(sessionId);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return row;
  },

  /** @returns {Promise<object[]>} */
  async list() {
    const db = await this._open();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const rows = await new Promise((res, rej) => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result ?? []);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return rows;
  },

  /** @param {string} sessionId */
  async delete(sessionId) {
    const db = await this._open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await new Promise((res, rej) => {
      const r = store.delete(sessionId);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    db.close();
  },
};
