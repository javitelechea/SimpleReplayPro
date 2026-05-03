/* ═══════════════════════════════════════════════════════════════════
 * LiveCapture Spike — usa js/livecapture/ (Fase 1, sin app principal).
 * ═══════════════════════════════════════════════════════════════════ */

import {
  VIDEO_SOURCE_LIVE_CAPTURE,
  SessionClock,
  detectSupportedMimeTypes,
  SegmentStore,
  ManifestStore,
  CaptureSession,
  buildVideoConstraints,
  RollingRecorder,
  ReplayEngine,
  concatenateSegments,
  canRunLiveCapture,
} from '../../js/livecapture/index.js';

const $ = (id) => document.getElementById(id);

let captureSession = null;
let rollingRecorder = null;
let sessionClock = null;
/** OPFS writer from SegmentStore.openSession, or null */
let segmentWriter = null;
let sessionId = null;
let mimeChosen = '';
let segments = []; // spike log + optional blob fallback
let marks = [];
let consolidatedBlob = null;
let consolidatedUrl = null;
let realDuration = null;
/** @type {ReplayEngine|null} */
let replayEngine = null;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setBadge(text, kind = 'muted') {
  const el = $('state-badge');
  el.textContent = text;
  el.className = `badge ${kind}`;
}

function diag(line) {
  const el = $('diag');
  const ts = new Date().toISOString().slice(11, 23);
  el.textContent += `[${ts}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function populateCodecs() {
  const sel = $('codec');
  sel.innerHTML = '';
  const supported = detectSupportedMimeTypes();
  if (supported.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— ningún codec soportado —';
    sel.appendChild(opt);
    return;
  }
  supported.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
}

async function ensureOpfsWriter() {
  if ($('storage').value !== 'opfs') return null;
  try {
    return await SegmentStore.openSession(sessionId);
  } catch (e) {
    diag(`OPFS no disponible: ${e.message} — fallback a memoria`);
    $('storage').value = 'memory';
    return null;
  }
}

async function requestPermissionAndListDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) {
    diag(`getUserMedia rechazado: ${e.name} — ${e.message}`);
    setBadge('permiso denegado', 'err');
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const sel = $('device-select');
  sel.innerHTML = '';
  cams.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Cámara ${i + 1}`;
    sel.appendChild(opt);
  });
  diag(`Dispositivos de video: ${cams.length}`);
  $('btn-start').disabled = cams.length === 0;
  setBadge('listo', 'ok');
}

function buildUiConstraints() {
  const deviceId = $('device-select').value || undefined;
  const res = $('resolution').value;
  return buildVideoConstraints({
    deviceId,
    resolution: res === 'any' ? 'any' : res,
  });
}

async function start() {
  segments = [];
  marks = [];
  consolidatedBlob = null;
  if (consolidatedUrl) {
    URL.revokeObjectURL(consolidatedUrl);
    consolidatedUrl = null;
  }
  realDuration = null;
  replayEngine?.unload();
  $('segments-table').querySelector('tbody').innerHTML = '';
  $('marks-table').querySelector('tbody').innerHTML = '';
  $('download-row').style.display = 'none';
  ['final-size', 'final-duration', 'final-real-duration', 'session-elapsed', 'duration-delta', 'seek-state']
    .forEach((id) => $(id).textContent = '—');
  ['seek-25', 'seek-50', 'seek-75', 'seek-end', 'seek-back'].forEach((id) => $(id).disabled = true);

  sessionId = `session-${Date.now()}`;
  mimeChosen = $('codec').value;
  const timeslice = parseInt($('timeslice').value, 10) || 4000;
  if (!mimeChosen) {
    diag('No hay codec seleccionado');
    setBadge('sin codec', 'err');
    return;
  }

  try {
    await ManifestStore.put({
      sessionId,
      status: 'recording',
      mimeType: mimeChosen,
      timesliceMs: timeslice,
      videoSource: VIDEO_SOURCE_LIVE_CAPTURE,
    });
  } catch (e) {
    diag(`ManifestStore: ${e.message}`);
  }

  sessionClock = new SessionClock();
  captureSession = new CaptureSession(buildUiConstraints());
  let stream;
  try {
    stream = await captureSession.open();
  } catch (e) {
    diag(`getUserMedia error: ${e.name} — ${e.message}`);
    setBadge('error', 'err');
    return;
  }

  $('live-preview-video').srcObject = stream;
  const settings = captureSession.getVideoSettings();
  $('stream-state').textContent = settings
    ? `${settings.width || '?'}×${settings.height || '?'} @ ${settings.frameRate || '?'}fps`
    : '—';
  diag(`Stream: ${JSON.stringify(settings)}`);

  segmentWriter = await ensureOpfsWriter();
  if (segmentWriter) diag(`OPFS: /livecapture/${sessionId}`);

  const onChunk = async (blob, meta) => {
    const idx = meta.index;
    const tArrival = meta.tArrivalSec;
    const prev = segments.length > 0 ? segments[segments.length - 1].tArrival : 0;
    const deltaT = tArrival - prev;
    const storage = segmentWriter ? 'opfs' : 'memory';
    const seg = {
      index: idx,
      tArrival,
      deltaT,
      size: blob.size,
      type: blob.type || mimeChosen,
      storage,
    };

    if (segmentWriter) {
      try {
        await segmentWriter.writeSegment(idx, blob);
      } catch (err) {
        diag(`OPFS write fail seg ${idx}: ${err.message} — fallback a memoria`);
        seg.blob = blob;
        seg.storage = 'memory';
      }
    } else {
      seg.blob = blob;
    }

    segments.push(seg);
    $('segment-count').textContent = String(segments.length);
    const total = segments.reduce((a, s) => a + s.size, 0);
    $('total-bytes').textContent = fmtBytes(total);
    $('last-segment').textContent = `Δ${deltaT.toFixed(2)}s · ${fmtBytes(blob.size)}`;
    appendSegmentRow(seg);
  };

  rollingRecorder = new RollingRecorder(stream, {
    mimeType: mimeChosen,
    timesliceMs: timeslice,
    sessionClock,
    onChunk,
  });

  rollingRecorder.start();

  diag(`Recorder start (mime=${mimeChosen}, timeslice=${timeslice})`);
  setBadge('grabando', 'ok');
  $('recorder-state').textContent = 'recording';
  startUiClock();

  $('btn-permission').disabled = true;
  $('btn-start').disabled = true;
  $('btn-stop').disabled = false;
  $('btn-mark').disabled = false;
  $('btn-consolidate').disabled = true;
}

let clockTimer = null;
function startUiClock() {
  stopUiClock();
  clockTimer = setInterval(() => {
    const t = sessionClock?.now() ?? 0;
    $('session-clock').textContent = t.toFixed(3);
  }, 100);
}
function stopUiClock() {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

function appendSegmentRow(seg) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${seg.index}</td>
    <td>${seg.tArrival.toFixed(3)}</td>
    <td>${seg.deltaT.toFixed(3)}</td>
    <td>${fmtBytes(seg.size)}</td>
    <td>${seg.type}</td>
    <td>${seg.storage}</td>`;
  $('segments-table').querySelector('tbody').appendChild(tr);
}

async function stop() {
  stopUiClock();
  if (rollingRecorder) await rollingRecorder.stop();
  rollingRecorder = null;

  if (captureSession) {
    captureSession.close();
    captureSession = null;
  }
  $('live-preview-video').srcObject = null;

  const elapsed = sessionClock?.elapsedSec() ?? 0;
  if (sessionClock) $('session-clock').textContent = elapsed.toFixed(3);
  diag(`Recorder stop. Sesión: ${elapsed.toFixed(3)} s`);
  setBadge('detenido', 'warn');
  $('recorder-state').textContent = 'inactive';

  try {
    await ManifestStore.put({
      sessionId,
      status: 'stopped',
      segmentCount: segments.length,
      totalBytes: segments.reduce((a, s) => a + s.size, 0),
      mimeType: mimeChosen,
      timesliceMs: parseInt($('timeslice').value, 10) || 4000,
    });
  } catch (e) {
    diag(`ManifestStore: ${e.message}`);
  }

  $('btn-stop').disabled = true;
  $('btn-mark').disabled = true;
  $('btn-consolidate').disabled = segments.length === 0;
}

async function consolidate() {
  setBadge('consolidando…', 'warn');
  let parts;
  if ($('storage').value === 'opfs' && segmentWriter) {
    parts = await SegmentStore.readSegmentFiles(sessionId);
    diag(`OPFS: ${parts.length} archivos leídos`);
  } else {
    parts = segments.map((s) => s.blob).filter(Boolean);
    diag(`Memoria: ${parts.length} blobs`);
  }
  if (parts.length === 0) {
    diag('No hay segmentos');
    setBadge('vacío', 'err');
    return;
  }

  consolidatedBlob = concatenateSegments(parts, mimeChosen || 'video/webm');
  consolidatedUrl = URL.createObjectURL(consolidatedBlob);
  $('final-size').textContent = fmtBytes(consolidatedBlob.size);

  if (!replayEngine) replayEngine = new ReplayEngine($('live-replay-video'));
  const { reportedDuration, realDuration: real } = await replayEngine.loadBlob(consolidatedBlob);

  $('final-duration').textContent = String(reportedDuration);
  realDuration = real;
  $('final-real-duration').textContent = `${realDuration.toFixed(3)} s`;

  const sessionElapsed = sessionClock?.elapsedSec() ?? 0;
  $('session-elapsed').textContent = `${sessionElapsed.toFixed(3)} s`;
  const delta = realDuration - sessionElapsed;
  const deltaEl = $('duration-delta');
  deltaEl.textContent = `${delta.toFixed(3)} s`;
  deltaEl.style.color =
    Math.abs(delta) < 0.5 ? 'var(--ok)' : Math.abs(delta) < 1.5 ? 'var(--warn)' : 'var(--err)';

  ['seek-25', 'seek-50', 'seek-75', 'seek-end', 'seek-back'].forEach((id) => $(id).disabled = false);

  const a = $('btn-download');
  a.href = consolidatedUrl;
  a.download = `livecapture-${sessionId || 'session'}.webm`;
  $('download-info').textContent = `${fmtBytes(consolidatedBlob.size)} · ${consolidatedBlob.type}`;
  $('download-row').style.display = 'flex';

  try {
    await ManifestStore.put({
      sessionId,
      status: 'consolidated',
      consolidatedAt: new Date().toISOString(),
      durationSec: realDuration,
      segmentCount: segments.length,
      totalBytes: consolidatedBlob.size,
    });
  } catch (e) {
    diag(`ManifestStore: ${e.message}`);
  }

  setBadge('consolidado', 'ok');
}

function wireSeekTests() {
  const v = $('live-replay-video');
  const labelFor = (frac) => `${(frac * 100).toFixed(0)}%`;

  function performSeek(frac) {
    if (!realDuration) return;
    const target = frac * realDuration;
    const t0 = performance.now();
    $('seek-state').textContent = `seeking ${labelFor(frac)} → ${target.toFixed(2)}s…`;
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked);
      const dt = performance.now() - t0;
      $('seek-state').textContent = `${labelFor(frac)}: t=${v.currentTime.toFixed(3)} s (Δ ${dt.toFixed(0)} ms) ✓`;
    };
    v.addEventListener('seeked', onSeeked);
    try {
      v.currentTime = target;
    } catch (e) {
      $('seek-state').textContent = `seek error: ${e.message}`;
    }
  }

  $('seek-25').addEventListener('click', () => performSeek(0.25));
  $('seek-50').addEventListener('click', () => performSeek(0.5));
  $('seek-75').addEventListener('click', () => performSeek(0.75));
  $('seek-end').addEventListener('click', () => performSeek(0.99));
  $('seek-back').addEventListener('click', () => performSeek(0.0));
}

function wireMarks() {
  $('btn-mark').addEventListener('click', () => {
    if (!sessionClock) return;
    const t = sessionClock.now();
    const note = `mark@${t.toFixed(2)}`;
    const m = { index: marks.length, tSession: t, note };
    marks.push(m);
    appendMarkRow(m);
    diag(`Marca creada: t_session=${t.toFixed(3)}s`);
  });
}

function appendMarkRow(m) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${m.index}</td>
    <td>${m.tSession.toFixed(3)}</td>
    <td>${m.note}</td>
    <td><span class="seek-final">—</span></td>
    <td><span class="seek-delta">—</span></td>
    <td><button class="btn-goto">Saltar a</button></td>`;
  tr.querySelector('.btn-goto').addEventListener('click', () => goToMark(m, tr));
  $('marks-table').querySelector('tbody').appendChild(tr);
}

function goToMark(m, tr) {
  if (!realDuration) {
    diag('Consolidá primero');
    return;
  }
  const v = $('live-replay-video');
  const target = Math.min(m.tSession, realDuration - 0.05);
  const onSeeked = () => {
    v.removeEventListener('seeked', onSeeked);
    const actual = v.currentTime;
    const delta = actual - m.tSession;
    tr.querySelector('.seek-final').textContent = actual.toFixed(3);
    const deltaEl = tr.querySelector('.seek-delta');
    deltaEl.textContent = delta.toFixed(3);
    deltaEl.style.color =
      Math.abs(delta) < 0.3 ? 'var(--ok)' : Math.abs(delta) < 1 ? 'var(--warn)' : 'var(--err)';
  };
  v.addEventListener('seeked', onSeeked);
  v.currentTime = target;
}

async function clearAll() {
  if (rollingRecorder && rollingRecorder.state !== 'inactive') await stop();
  const id = sessionId;

  segments = [];
  marks = [];
  sessionId = null;
  mimeChosen = '';
  segmentWriter = null;
  sessionClock = null;
  consolidatedBlob = null;
  if (consolidatedUrl) {
    URL.revokeObjectURL(consolidatedUrl);
    consolidatedUrl = null;
  }
  realDuration = null;
  replayEngine?.unload();

  $('segment-count').textContent = '0';
  $('total-bytes').textContent = '0';
  $('last-segment').textContent = '—';
  $('session-clock').textContent = '0.000';
  ['final-size', 'final-duration', 'final-real-duration', 'session-elapsed', 'duration-delta', 'seek-state']
    .forEach((k) => $(k).textContent = '—');
  $('segments-table').querySelector('tbody').innerHTML = '';
  $('marks-table').querySelector('tbody').innerHTML = '';
  $('download-row').style.display = 'none';
  ['seek-25', 'seek-50', 'seek-75', 'seek-end', 'seek-back'].forEach((k) => $(k).disabled = true);
  $('btn-start').disabled = false;
  $('btn-stop').disabled = true;
  $('btn-consolidate').disabled = true;
  $('btn-mark').disabled = true;
  setBadge('idle', 'muted');

  if (id && $('storage').value === 'opfs') {
    try {
      await SegmentStore.deleteSession(id);
      diag(`OPFS: eliminado /livecapture/${id}`);
    } catch (e) {
      diag(`OPFS clear error: ${e.message}`);
    }
  }
  if (id) {
    try {
      await ManifestStore.delete(id);
    } catch {
      /* noop */
    }
  }
}

function bootstrap() {
  if (!canRunLiveCapture()) {
    diag('⚠ Entorno no apto: contexto seguro + getUserMedia + MediaRecorder');
    setBadge('no soportado', 'err');
  }
  if (!window.isSecureContext) {
    diag('⚠ Contexto NO seguro: usá http://localhost o https.');
    setBadge('contexto inseguro', 'err');
  }
  if (!('MediaRecorder' in window)) {
    diag('⚠ MediaRecorder no disponible.');
    setBadge('sin MediaRecorder', 'err');
  }

  replayEngine = new ReplayEngine($('live-replay-video'));

  populateCodecs();
  wireSeekTests();
  wireMarks();

  $('btn-permission').addEventListener('click', requestPermissionAndListDevices);
  $('btn-start').addEventListener('click', start);
  $('btn-stop').addEventListener('click', stop);
  $('btn-consolidate').addEventListener('click', consolidate);
  $('btn-clear').addEventListener('click', clearAll);

  SegmentStore.estimate().then((est) => {
    if (est?.quota) {
      diag(`Cuota storage: ${(est.quota / 1024 / 1024 / 1024).toFixed(2)} GB · usada: ${(est.usage / 1024 / 1024).toFixed(1)} MB`);
    }
  });

  diag(`videoSource constante: "${VIDEO_SOURCE_LIVE_CAPTURE}" (spike + ManifestStore).`);
  diag('Spike listo (módulos js/livecapture/). Pulsá “Pedir permiso cámara”.');
}

bootstrap();
