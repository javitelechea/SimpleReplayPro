/**
 * Comparte video local con player.html vía OPFS (mismo origin, sin copiar por BroadcastChannel).
 */

const ROOT = 'popout-share';
const CHUNK_BYTES = 2 * 1024 * 1024;

export function canUsePopoutMediaShare() {
    return typeof navigator.storage?.getDirectory === 'function';
}

function safeShareId(raw) {
    const s = String(raw || 'share').replace(/[^a-zA-Z0-9_-]/g, '_');
    return s.slice(0, 80) || 'share';
}

function pickFilename(file) {
    const name = typeof file?.name === 'string' ? file.name : '';
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name.slice(-120);
    const type = file?.type || 'video/mp4';
    if (type.includes('webm')) return 'video.webm';
    if (type.includes('quicktime') || type.includes('mov')) return 'video.mov';
    return 'video.mp4';
}

/**
 * Escribe el archivo en OPFS por trozos (no bloquea la UI).
 * @param {File|Blob} file
 * @param {string} shareId
 */
export async function writeLocalFileForPopout(file, shareId) {
    if (!canUsePopoutMediaShare()) {
        throw new Error('OPFS no disponible');
    }
    const sid = safeShareId(shareId);
    const filename = pickFilename(file);
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(ROOT, { create: true });
    const dir = await base.getDirectoryHandle(sid, { create: true });
    const fh = await dir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    const size = file.size || 0;
    let offset = 0;
    while (offset < size) {
        const end = Math.min(offset + CHUNK_BYTES, size);
        await writable.write(file.slice(offset, end));
        offset = end;
        await new Promise((r) => setTimeout(r, 0));
    }
    await writable.close();
    return {
        shareId: sid,
        name: filename,
        type: file.type || 'video/mp4',
        size,
    };
}

/**
 * @param {{ shareId: string, name: string }} meta
 * @returns {Promise<File>}
 */
export async function readLocalFileForPopout(meta) {
    if (!canUsePopoutMediaShare()) {
        throw new Error('OPFS no disponible');
    }
    const sid = safeShareId(meta?.shareId);
    const name = meta?.name || 'video.mp4';
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(ROOT);
    const dir = await base.getDirectoryHandle(sid);
    const fh = await dir.getFileHandle(name);
    return fh.getFile();
}
