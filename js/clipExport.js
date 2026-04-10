/* ═══════════════════════════════════════════
   SimpleReplay — Clip Export (FFmpeg.wasm)
   Lazy-loads FFmpeg only on first use.
   Wrapper + worker served locally (~7 KB).
   Core WASM fetched from CDN on demand (~31 MB).
   ═══════════════════════════════════════════ */

export const ClipExport = (() => {
    let _ffmpeg = null;
    let _loaded = false;
    let _loading = false;
    let _loadPromise = null;

    const CORE_VER = '0.12.10';
    const CDN = 'https://cdn.jsdelivr.net/npm';
    const CORE_BASE = `${CDN}/@ffmpeg/core@${CORE_VER}/dist/umd`;

    async function _toBlobURL(url, mimeType) {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        return URL.createObjectURL(new Blob([buf], { type: mimeType }));
    }

    function _loadScript(url) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Failed to load FFmpeg script'));
            document.head.appendChild(s);
        });
    }

    async function _ensureLoaded(onProgress) {
        if (_ffmpeg && _loaded) return _ffmpeg;
        if (_loadPromise) return _loadPromise;

        _loading = true;
        _loadPromise = (async () => {
            if (onProgress) onProgress('Descargando exportador…');

            // 1) Load local UMD bundle (same-origin, no CORS issues)
            if (!window.FFmpegWASM) {
                await _loadScript('js/vendor/ffmpeg/ffmpeg.js');
            }

            const { FFmpeg } = window.FFmpegWASM;
            const ffmpeg = new FFmpeg();

            if (onProgress) onProgress('Descargando motor (~31 MB, solo la primera vez)…');

            // 2) Core files from CDN → blob URLs (large, cached by browser)
            const [coreURL, wasmURL] = await Promise.all([
                _toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
                _toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
            ]);

            if (onProgress) onProgress('Iniciando exportador…');
            await ffmpeg.load({ coreURL, wasmURL });

            _ffmpeg = ffmpeg;
            _loaded = true;
            _loading = false;
            return ffmpeg;
        })();

        try {
            return await _loadPromise;
        } catch (e) {
            _loadPromise = null;
            _loading = false;
            throw e;
        }
    }

    async function _fetchLocalVideo(blobUrl) {
        const resp = await fetch(blobUrl);
        const buf = await resp.arrayBuffer();
        return new Uint8Array(buf);
    }

    function _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 200);
    }

    function _sanitizeFilename(str) {
        return (str || 'clip').replace(/[^a-z0-9áéíóúñü _-]/gi, '').replace(/\s+/g, '_').slice(0, 60) || 'clip';
    }

    function _toMMSS(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const mm = Math.floor(s / 60).toString().padStart(2, '0');
        const ss = (s % 60).toString().padStart(2, '0');
        return `${mm}${ss}`;
    }

    /**
     * Export a single clip as MP4.
     * @param {string} blobUrl - local video blob URL
     * @param {number} startSec
     * @param {number} endSec
     * @param {string} [label] - used for the filename
     * @param {Function} [onProgress] - status callback
     */
    async function exportClip(blobUrl, startSec, endSec, label, onProgress) {
        const ffmpeg = await _ensureLoaded(onProgress);

        if (onProgress) onProgress('Leyendo video…');
        const videoData = await _fetchLocalVideo(blobUrl);
        await ffmpeg.writeFile('input.mp4', videoData);

        const duration = endSec - startSec;
        if (onProgress) onProgress('Cortando clip…');

        await ffmpeg.exec([
            '-ss', String(startSec),
            '-i', 'input.mp4',
            '-t', String(duration),
            '-c', 'copy',
            '-movflags', '+faststart',
            'output.mp4',
        ]);

        const data = await ffmpeg.readFile('output.mp4');
        const blob = new Blob([data.buffer], { type: 'video/mp4' });

        const filename = `${_sanitizeFilename(label)}_${_toMMSS(startSec)}-${_toMMSS(endSec)}.mp4`;
        _downloadBlob(blob, filename);

        await ffmpeg.deleteFile('input.mp4');
        await ffmpeg.deleteFile('output.mp4');

        if (onProgress) onProgress(null);
    }

    /**
     * Export multiple clips concatenated as a single MP4.
     * @param {string} blobUrl - local video blob URL
     * @param {{ startSec: number, endSec: number }[]} clips
     * @param {string} [label] - playlist name for the filename
     * @param {Function} [onProgress] - status callback
     */
    async function exportPlaylist(blobUrl, clips, label, onProgress) {
        if (!clips || clips.length === 0) return;

        const ffmpeg = await _ensureLoaded(onProgress);

        if (onProgress) onProgress('Leyendo video…');
        const videoData = await _fetchLocalVideo(blobUrl);
        await ffmpeg.writeFile('input.mp4', videoData);

        const segmentNames = [];
        for (let i = 0; i < clips.length; i++) {
            const c = clips[i];
            const segName = `seg_${i}.mp4`;
            if (onProgress) onProgress(`Cortando clip ${i + 1} de ${clips.length}…`);

            await ffmpeg.exec([
                '-ss', String(c.startSec),
                '-i', 'input.mp4',
                '-t', String(c.endSec - c.startSec),
                '-c', 'copy',
                '-movflags', '+faststart',
                segName,
            ]);
            segmentNames.push(segName);
        }

        const concatList = segmentNames.map(n => `file '${n}'`).join('\n');
        await ffmpeg.writeFile('list.txt', new TextEncoder().encode(concatList));

        if (onProgress) onProgress('Uniendo clips…');
        await ffmpeg.exec([
            '-f', 'concat',
            '-safe', '0',
            '-i', 'list.txt',
            '-c', 'copy',
            '-movflags', '+faststart',
            'playlist.mp4',
        ]);

        const data = await ffmpeg.readFile('playlist.mp4');
        const blob = new Blob([data.buffer], { type: 'video/mp4' });

        const filename = `${_sanitizeFilename(label)}.mp4`;
        _downloadBlob(blob, filename);

        for (const seg of segmentNames) {
            await ffmpeg.deleteFile(seg).catch(() => {});
        }
        await ffmpeg.deleteFile('input.mp4').catch(() => {});
        await ffmpeg.deleteFile('list.txt').catch(() => {});
        await ffmpeg.deleteFile('playlist.mp4').catch(() => {});

        if (onProgress) onProgress(null);
    }

    function isLoading() {
        return _loading;
    }

    return { exportClip, exportPlaylist, isLoading };
})();
