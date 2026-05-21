/**
 * Comparte video local con player.html vía OPFS (mismo origin).
 * El descriptor va en localStorage para que el popout lo lea al abrir.
 */

const ROOT = 'popout-share';
const CHUNK_BYTES = 2 * 1024 * 1024;
export const POPOUT_STAGED_LS_KEY = 'sr-popout-staged-media-v1';

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

export function writeStagedPopoutDescriptor(descriptor) {
    localStorage.setItem(POPOUT_STAGED_LS_KEY, JSON.stringify(descriptor));
}

export function peekStagedPopoutDescriptor() {
    const raw = localStorage.getItem(POPOUT_STAGED_LS_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function consumeStagedPopoutDescriptor() {
    const d = peekStagedPopoutDescriptor();
    if (d) localStorage.removeItem(POPOUT_STAGED_LS_KEY);
    return d;
}

/** Payload para postMessage / BroadcastChannel (File se clona sin copiar el blob). */
export function buildLocalFilePopoutPayload(file) {
    if (!file || !file.size) return null;
    return {
        kind: 'local',
        file,
        name: file.name || 'video.mp4',
        type: file.type || 'video/mp4',
        size: file.size,
    };
}

/** Fallback si el File no se puede clonar entre ventanas (p. ej. Safari). */
export async function buildLocalBufferPopoutPayload(file) {
    if (!file || !file.size) return null;
    const buffer = await file.arrayBuffer();
    return {
        kind: 'local-buffer',
        buffer,
        name: file.name || 'video.mp4',
        type: file.type || 'video/mp4',
        size: file.size,
    };
}

/**
 * Escribe el archivo en OPFS por trozos (no bloquea la UI).
 */
export async function writeLocalFileForPopout(file, shareId) {
    if (!canUsePopoutMediaShare()) {
        throw new Error('OPFS no disponible en este navegador');
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
 * Prepara video local: OPFS + descriptor en localStorage (lo lee player.html al iniciar).
 * @returns {Promise<object>} descriptor { kind: 'local-opfs', shareId, name, type, size }
 */
export async function stageLocalFileForPopout(file, gameId) {
    if (!file || !file.size) {
        throw new Error('Archivo de video no válido');
    }
    const meta = await writeLocalFileForPopout(file, gameId || 'local');
    const descriptor = { kind: 'local-opfs', ...meta };
    writeStagedPopoutDescriptor(descriptor);
    return descriptor;
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
    const file = await fh.getFile();
    if (!file.size) {
        throw new Error('El archivo en OPFS está vacío (¿se abrió el popout antes de terminar la copia?)');
    }
    return file;
}
