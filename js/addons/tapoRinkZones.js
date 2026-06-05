/**
 * Tapo torre hockey — 9 zonas + flechas PTZ en SimpleReplay (Captura en vivo).
 * Requiere tapo-onvif-test en http://127.0.0.1:5050
 */

const ZONE_ROWS = [
  ['rival_izq', 'rival_cen', 'rival_der'],
  ['neut_izq', 'neut_cen', 'neut_der'],
  ['prop_izq', 'prop_cen', 'prop_der'],
];

const ZONE_LABELS = {
  rival_izq: 'R. izq',
  rival_cen: 'R. cen',
  rival_der: 'R. der',
  neut_izq: 'N. izq',
  neut_cen: 'N. cen',
  neut_der: 'N. der',
  prop_izq: 'P. izq',
  prop_cen: 'P. cen',
  prop_der: 'P. der',
};

/** Número en teclado de teléfono (7-8-9 / 4-5-6 / 1-2-3). */
const ZONE_PHONE_NUM = {
  rival_izq: 7,
  rival_cen: 8,
  rival_der: 9,
  neut_izq: 4,
  neut_cen: 5,
  neut_der: 6,
  prop_izq: 1,
  prop_cen: 2,
  prop_der: 3,
};

const MOVES = {
  up: { x: 0, y: 0.5, zoom: 0 },
  down: { x: 0, y: -0.5, zoom: 0 },
  left: { x: -0.5, y: 0, zoom: 0 },
  right: { x: 0.5, y: 0, zoom: 0 },
};

/** Orden teclado numérico de teléfono (7-8-9 / 4-5-6 / 1-2-3). */
const PHONE_ZONE_KEYS = {
  7: 'rival_izq',
  8: 'rival_cen',
  9: 'rival_der',
  4: 'neut_izq',
  5: 'neut_cen',
  6: 'neut_der',
  1: 'prop_izq',
  2: 'prop_cen',
  3: 'prop_der',
};

const ARROW_TO_DIR = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

function zoneIdFromKeyEvent(e) {
  const k = e.key;
  if (k >= '1' && k <= '9') return PHONE_ZONE_KEYS[k];
  const m = /^Numpad([1-9])$/.exec(e.code || '');
  if (m) return PHONE_ZONE_KEYS[m[1]];
  return null;
}

function isLocalDev() {
  const host = String(location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function isTapoStreamUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  if (/tapo/.test(u)) return true;
  if (/127\.0\.0\.1:8888|localhost:8888/.test(u) && /\/tapo/.test(u)) return true;
  return false;
}

function isLocalhostStreamUrl(url) {
  const u = String(url || '').toLowerCase();
  return /127\.0\.0\.1|localhost/.test(u);
}

function shouldShowPanel(url, kind) {
  if (kind !== 'ip') return false;
  if (isTapoStreamUrl(url)) {
    // En producción, la URL tapo por defecto (127.0.0.1) no aplica — evita PTZ fuera de dev local.
    if (!isLocalDev() && isLocalhostStreamUrl(url)) return false;
    return true;
  }
  if (isLocalDev() && !url) return true;
  return false;
}

function getPtzBase() {
  try {
    return localStorage.getItem('srTapoPtzUrl') || 'http://127.0.0.1:5050';
  } catch {
    return 'http://127.0.0.1:5050';
  }
}

/** Evita saturar :5050 con muchos POST PTZ a la vez (p. ej. grabando + joystick). */
let ptzMutateChain = Promise.resolve();

async function ptzApi(path, body, options = {}) {
  const base = getPtzBase();
  const useGet = path === '/health' || path === '/zones';
  const timeoutMs = options.timeoutMs ?? (useGet ? 2500 : 35000);

  const run = async () => {
    const res = await fetch(`${base}${path}`, {
      method: useGet ? 'GET' : 'POST',
      headers: useGet ? undefined : { 'Content-Type': 'application/json' },
      body: useGet ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || data.error || res.statusText);
    }
    return res.json();
  };

  if (useGet) return run();
  const task = ptzMutateChain.then(run);
  ptzMutateChain = task.catch(() => {});
  return task;
}

async function pingPtzServer() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ptzApi('/health', null, { timeoutMs: 2000 });
      return true;
    } catch (_) {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 350));
    }
  }
  return false;
}

/**
 * @param {{
 *   host: HTMLElement,
 *   getStreamUrl: () => string,
 *   getSourceKind: () => string,
 *   getIsRecording?: () => boolean,
 * }} opts
 */
export function initTapoRinkZones(opts) {
  if (!opts?.host) return null;

  const host = opts.host;
  const startExpanded = (() => {
    try {
      return localStorage.getItem('srTapoRinkExpanded') === '1';
    } catch {
      return false;
    }
  })();

  host.innerHTML = `
    <div class="tapo-rink${startExpanded ? '' : ' tapo-rink--collapsed'}">
      <button type="button" class="tapo-rink__toggle" data-tapo-collapse-toggle aria-expanded="${startExpanded}">
        <span class="tapo-rink__title">Tapo · cancha</span>
        <span class="tapo-rink__chevron" aria-hidden="true">▾</span>
      </button>
      <div class="tapo-rink__body" data-tapo-body>
        <div class="tapo-rink__head">
          <button type="button" class="btn btn-sm btn-outline tapo-rink__ctrl-btn" data-tapo-gamepad-toggle>🎮 Joystick</button>
          <button type="button" class="btn btn-sm btn-outline tapo-rink__ctrl-btn" data-tapo-kbd-toggle>⌨ Teclado</button>
          <button type="button" class="btn btn-sm btn-outline" data-tapo-setup-toggle>Configurar zonas</button>
        </div>
        <p class="tapo-rink__ctrl-hint hidden" data-tapo-ctrl-hint></p>
        <div class="tapo-ptz-pad" data-tapo-pad>
          <span></span><button type="button" data-dir="up">↑</button><span></span>
          <button type="button" data-dir="left">←</button><button type="button" data-tapo-stop>STOP</button><button type="button" data-dir="right">→</button>
          <span></span><button type="button" data-dir="down">↓</button><span></span>
        </div>
        <div class="tapo-rink__grid" data-tapo-grid></div>
        <div class="tapo-rink__setup-extra hidden" data-tapo-setup-extra>
          <p class="tapo-rink__hint">Tocá una celda, ajustá con las flechas y guardá.</p>
          <button type="button" class="btn btn-sm btn-primary" data-tapo-save-zone disabled>Guardar esta zona</button>
        </div>
        <div class="tapo-gp-test">
          <button type="button" class="btn btn-sm btn-outline" data-tapo-gp-test-toggle>Probar mando</button>
          <pre class="tapo-gp-test__out hidden" data-tapo-gp-monitor aria-live="polite"></pre>
        </div>
        <p class="tapo-rink__status" data-tapo-status></p>
      </div>
    </div>
  `;

  const rinkRoot = host.querySelector('.tapo-rink');
  const collapseToggle = host.querySelector('[data-tapo-collapse-toggle]');

  function setExpanded(open) {
    rinkRoot?.classList.toggle('tapo-rink--collapsed', !open);
    if (collapseToggle) {
      collapseToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    try {
      localStorage.setItem('srTapoRinkExpanded', open ? '1' : '0');
    } catch (_) { /* noop */ }
  }

  collapseToggle?.addEventListener('click', () => {
    const open = rinkRoot?.classList.contains('tapo-rink--collapsed');
    setExpanded(open);
  });

  const gridEl = host.querySelector('[data-tapo-grid]');
  const setupExtra = host.querySelector('[data-tapo-setup-extra]');
  const statusEl = host.querySelector('[data-tapo-status]');
  const setupToggle = host.querySelector('[data-tapo-setup-toggle]');
  const gamepadToggle = host.querySelector('[data-tapo-gamepad-toggle]');
  const kbdToggle = host.querySelector('[data-tapo-kbd-toggle]');
  const ctrlHint = host.querySelector('[data-tapo-ctrl-hint]');
  const saveZoneBtn = host.querySelector('[data-tapo-save-zone]');
  const padEl = host.querySelector('[data-tapo-pad]');
  const gpTestToggle = host.querySelector('[data-tapo-gp-test-toggle]');
  const gpMonitor = host.querySelector('[data-tapo-gp-monitor]');

  let gpTestActive = false;
  let gpTestLoopId = 0;

  let kbdArmed = false;
  let kbdArrowHeld = null;
  let gamepadArmed = false;
  let gamepadLoopId = 0;
  let gamepadStickActive = false;
  let gamepadReady = false;
  let gamepadWaitingMsg = false;
  let lockedGamepadIndex = -1;
  let prevHatDir = null;
  let prevLeftStickDir = null;
  let prevRightStickSector = null;
  let prevR3Pressed = false;
  let lastZoneGotoAt = 0;
  let lastRightZoneGotoAt = 0;
  /** Posición actual en la grilla 3×3 (arranca en 5 = neut_cen). */
  let currentZoneCell = { row: 1, col: 1 };

  const GP_STICK_THRESH = 0.5;
  const GP_RIGHT_STICK_THRESH = 0.42;
  const GP_ZONE_AXIS_FRAC = 0.55;
  const GP_RIGHT_X = 2;
  const GP_RIGHT_Y = 3;
  const GP_BTN_R3 = 11;
  const GP_DPAD_BTNS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

  let setupMode = false;
  let selectedZoneId = null;
  let zones = [];
  let activeDir = null;
  let activeBtn = null;
  let dragPointerId = null;
  /** Si cambia, el move en curso debe frenar al terminar (evita race al soltar rápido). */
  let ptzHoldId = 0;
  let ptzServerOk = false;
  let ptzHealthFailStreak = 0;

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('tapo-rink__status--err', Boolean(isError));
  }

  function zoneCellFromId(zoneId) {
    for (let r = 0; r < ZONE_ROWS.length; r += 1) {
      const c = ZONE_ROWS[r].indexOf(zoneId);
      if (c >= 0) return { row: r, col: c };
    }
    return { row: 1, col: 1 };
  }

  function setCurrentZoneCell(row, col, zoneId) {
    currentZoneCell = {
      row: Math.max(0, Math.min(2, row)),
      col: Math.max(0, Math.min(2, col)),
    };
    renderGrid();
    if (zoneId && !setupMode) {
      const n = ZONE_PHONE_NUM[zoneId];
      if (n) setStatus(`Zona actual: ${n}`);
    }
  }

  function renderGrid() {
    gridEl.innerHTML = '';
    ZONE_ROWS.forEach((row, r) => {
      row.forEach((id, c) => {
        const z = zones.find((x) => x.id === id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tapo-rink__cell';
        btn.dataset.zoneId = id;
        btn.textContent = ZONE_LABELS[id] || id;
        if (z?.configured) btn.classList.add('tapo-rink__cell--ok');
        if (id === selectedZoneId) btn.classList.add('tapo-rink__cell--sel');
        if (r === currentZoneCell.row && c === currentZoneCell.col) {
          btn.classList.add('tapo-rink__cell--current');
        }
        gridEl.appendChild(btn);
      });
    });
  }

  async function loadZones() {
    const data = await ptzApi('/zones');
    zones = data.zones || [];
    renderGrid();
  }

  async function gotoZone(id) {
    await ptzApi(`/zones/${id}/goto`);
    const cell = zoneCellFromId(id);
    setCurrentZoneCell(cell.row, cell.col, id);
  }

  async function saveZone(id) {
    const data = await ptzApi(`/zones/${id}/save`);
    setStatus(`Guardado: ${ZONE_LABELS[id]}`, false);
    if (data.zone) {
      const i = zones.findIndex((z) => z.id === id);
      if (i >= 0) zones[i] = { ...zones[i], ...data.zone, configured: true };
    }
    await loadZones();
  }

  function syncCtrlHint() {
    if (!ctrlHint) return;
    const on = kbdArmed || gamepadArmed;
    ctrlHint.classList.toggle('hidden', !on);
    if (kbdArmed && gamepadArmed) {
      ctrlHint.textContent = 'Teclado + joystick activos · Esc apaga';
    } else if (gamepadArmed) {
      ctrlHint.textContent = 'Stick der. = ir directo a zona 1-9 · Stick izq. = pasar de zona · Cruceta = PTZ · R3 = zona 5 · Esc apaga';
    } else if (kbdArmed) {
      ctrlHint.textContent = 'Flechas = mover · 1-9 = zonas (teléfono) · Esc apaga';
    }
  }

  function setKbdArmed(on) {
    if (!on && !kbdArmed) return;
    if (on && gamepadArmed) setGamepadArmed(false);
    kbdArmed = on;
    kbdToggle?.classList.toggle('is-active', on);
    kbdToggle?.setAttribute('aria-pressed', on ? 'true' : 'false');
    rinkRoot?.classList.toggle('tapo-rink--kbd-armed', on || gamepadArmed);
    if (!on) {
      kbdArrowHeld = null;
      if (!gamepadArmed) endPtzHold();
      if (!gamepadArmed && !statusEl.classList.contains('tapo-rink__status--err')) setStatus('');
    } else {
      setStatus('Teclado activo');
      document.activeElement?.blur?.();
    }
    syncCtrlHint();
  }

  function flashZoneCell(zoneId) {
    const cell = gridEl.querySelector(`[data-zone-id="${zoneId}"]`);
    if (!cell) return;
    cell.classList.add('tapo-rink__cell--flash');
    setTimeout(() => cell.classList.remove('tapo-rink__cell--flash'), 280);
  }

  async function triggerZoneByKey(zoneId) {
    flashZoneCell(zoneId);
    if (setupMode) {
      selectedZoneId = zoneId;
      saveZoneBtn.disabled = false;
      renderGrid();
      setStatus(`Calibrando: ${ZONE_LABELS[zoneId]}`);
      return;
    }
    const z = zones.find((x) => x.id === zoneId);
    if (!z?.configured) {
      setStatus('Zona sin guardar — Configurar zonas', true);
      return;
    }
    await gotoZone(zoneId);
  }

  function onTapoKeyDown(e) {
    if (gamepadArmed && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setGamepadArmed(false);
      return;
    }
    if (!kbdArmed || host.classList.contains('hidden')) return;
    if (isTypingTarget(e.target)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setKbdArmed(false);
      setGamepadArmed(false);
      return;
    }

    const dir = ARROW_TO_DIR[e.key];
    if (dir) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && kbdArrowHeld === dir) return;
      kbdArrowHeld = dir;
      const btn = padEl.querySelector(`[data-dir="${dir}"]`);
      startPtzHold(dir, btn);
      return;
    }

    if (e.repeat) return;
    const zoneId = zoneIdFromKeyEvent(e);
    if (!zoneId) return;

    e.preventDefault();
    e.stopPropagation();
    triggerZoneByKey(zoneId).catch((err) => setStatus(err.message, true));
  }

  function onTapoKeyUp(e) {
    if (!kbdArmed) return;
    const dir = ARROW_TO_DIR[e.key];
    if (!dir || kbdArrowHeld !== dir) return;
    e.preventDefault();
    e.stopPropagation();
    kbdArrowHeld = null;
    endPtzHold();
  }

  kbdToggle?.addEventListener('click', () => {
    if (!host.classList.contains('hidden') && rinkRoot?.classList.contains('tapo-rink--collapsed')) {
      setExpanded(true);
    }
    setKbdArmed(!kbdArmed);
  });

  window.addEventListener('keydown', onTapoKeyDown, true);
  window.addEventListener('keyup', onTapoKeyUp, true);

  function formatGamepadSlot(p, index) {
    if (!p?.connected) return `  [${index}] — vacío`;
    const axes = (p.axes || [])
      .slice(0, 8)
      .map((v, i) => `a${i}:${Number(v).toFixed(2)}`)
      .join(' ');
    const pressed = (p.buttons || [])
      .map((b, i) => (b?.pressed ? i : -1))
      .filter((i) => i >= 0);
    return `  [${index}] ${p.id || 'sin nombre'}\n    ${axes || 'sin ejes'}\n    botones: ${pressed.length ? pressed.join(', ') : 'ninguno'}`;
  }

  function buildGamepadReport() {
    const api = Boolean(navigator.getGamepads);
    if (!api) return 'Gamepad API: no disponible en este navegador';
    wakeGamepadApi();
    const pads = navigator.getGamepads();
    const lines = ['Gamepad API: sí', 'Pulsá ▶ o R2 si todo sale vacío.', ''];
    let found = 0;
    for (let i = 0; i < pads.length; i += 1) {
      if (pads[i]?.connected) {
        found += 1;
        lines.push(formatGamepadSlot(pads[i], i));
      }
    }
    if (!found) {
      lines.push('  (ningún mando detectado aún)');
    }
    return lines.join('\n');
  }

  function pollGamepadTest() {
    if (!gpTestActive || !gpMonitor) return;
    gpMonitor.textContent = buildGamepadReport();
    gpTestLoopId = requestAnimationFrame(pollGamepadTest);
  }

  function setGamepadTest(on) {
    gpTestActive = on;
    gpTestToggle?.classList.toggle('is-active', on);
    gpMonitor?.classList.toggle('hidden', !on);
    if (!on) {
      if (gpTestLoopId) cancelAnimationFrame(gpTestLoopId);
      gpTestLoopId = 0;
      return;
    }
    setExpanded(true);
    gpMonitor.textContent = buildGamepadReport();
    pollGamepadTest();
  }

  gpTestToggle?.addEventListener('click', () => {
    wakeGamepadApi();
    setGamepadTest(!gpTestActive);
  });

  window.__tapoGamepadScan = () => {
    wakeGamepadApi();
    const report = buildGamepadReport();
    console.log('[Tapo gamepad]\n' + report);
    return navigator.getGamepads?.();
  };

  function clearPtzOfflineStatus() {
    const t = statusEl.textContent || '';
    if (
      /Falta tapo-onvif|Tapo PTZ no responde/.test(t)
    ) {
      setStatus('');
    }
  }

  async function checkPtzServer() {
    const ok = await pingPtzServer();
    if (ok) {
      ptzServerOk = true;
      ptzHealthFailStreak = 0;
      clearPtzOfflineStatus();
      try {
        await loadZones();
      } catch (_) { /* zonas en otro intento */ }
      return;
    }
    ptzServerOk = false;
    ptzHealthFailStreak += 1;
    if (ptzHealthFailStreak < 2) return;

    const recording = Boolean(opts.getIsRecording?.());
    if (recording) {
      setStatus('Tapo PTZ ocupado o sin respuesta — reintentá la zona', true);
    } else {
      setStatus('Falta tapo-onvif-test (npm start en tapo-onvif-test)', true);
    }
  }

  function updateVisibility() {
    const url = opts.getStreamUrl();
    const kind = opts.getSourceKind();
    const show = shouldShowPanel(url, kind);
    const wasVisible = !host.classList.contains('hidden');
    host.classList.toggle('hidden', !show);
    if (!show) {
      if (wasVisible || kbdArmed || gamepadArmed) {
        setKbdArmed(false);
        setGamepadArmed(false);
        setGamepadTest(false);
      }
      return;
    }
    checkPtzServer();
  }

  gridEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-zone-id]');
    if (!btn) return;
    const id = btn.dataset.zoneId;
    if (setupMode) {
      selectedZoneId = id;
      saveZoneBtn.disabled = false;
      renderGrid();
      setStatus(`Calibrando: ${ZONE_LABELS[id]}`);
      return;
    }
    const z = zones.find((x) => x.id === id);
    if (!z?.configured) {
      setStatus('Zona sin guardar — Configurar zonas', true);
      return;
    }
    try {
      await gotoZone(id);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  setupToggle.addEventListener('click', () => {
    setupMode = !setupMode;
    setupExtra.classList.toggle('hidden', !setupMode);
    setupToggle.textContent = setupMode ? 'Listo' : 'Configurar zonas';
    if (!setupMode) {
      selectedZoneId = null;
      saveZoneBtn.disabled = true;
      renderGrid();
    }
  });

  saveZoneBtn.addEventListener('click', async () => {
    if (!selectedZoneId) return;
    saveZoneBtn.disabled = true;
    try {
      await saveZone(selectedZoneId);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      saveZoneBtn.disabled = !selectedZoneId;
    }
  });

  function dirAtPoint(cx, cy) {
    const el = document.elementFromPoint(cx, cy);
    const b = el?.closest?.('[data-dir]');
    return b ? { dir: b.dataset.dir, btn: b } : null;
  }

  function clearPtzUi() {
    activeDir = null;
    activeBtn = null;
    dragPointerId = null;
    padEl.querySelectorAll('[data-dir]').forEach((b) => b.classList.remove('is-active'));
  }

  async function endPtzHold() {
    const hadMovement = activeDir !== null || gamepadStickActive || dragPointerId !== null;
    ptzHoldId += 1;
    gamepadStickActive = false;
    clearPtzUi();
    if (!hadMovement) return;
    if (host.classList.contains('hidden')) return;
    try {
      await ptzApi('/camera/stop');
    } catch (err) {
      if (!host.classList.contains('hidden')) setStatus(err.message, true);
    }
  }

  function wakeGamepadApi() {
    try {
      const pads = navigator.getGamepads?.();
      if (!pads) return;
      for (let i = 0; i < pads.length; i += 1) {
        if (pads[i]) pads[i].timestamp;
      }
    } catch (_) { /* noop */ }
  }

  function pickGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (lockedGamepadIndex >= 0 && pads[lockedGamepadIndex]?.connected) {
      return pads[lockedGamepadIndex];
    }
    let sonyPad = null;
    let anyPad = null;
    for (let i = 0; i < pads.length; i += 1) {
      const p = pads[i];
      if (!p?.connected) continue;
      anyPad = p;
      const id = String(p.id || '').toLowerCase();
      if (/sony|dualshock|wireless controller|054c|ps4|ps5|gamepad/i.test(id)) {
        sonyPad = p;
        lockedGamepadIndex = i;
        break;
      }
    }
    const gp = sonyPad || anyPad;
    if (gp && lockedGamepadIndex < 0) {
      lockedGamepadIndex = pads.indexOf(gp);
    }
    return gp;
  }

  function stopGamepadLoop() {
    if (gamepadLoopId) cancelAnimationFrame(gamepadLoopId);
    gamepadLoopId = 0;
  }

  function dpadDirFromHat(_gp) {
    return null;
  }

  function handleGamepadDpad(gp) {
    let hatDir = dpadDirFromHat(gp);
    if (!hatDir) {
      for (const [idx, dir] of Object.entries(GP_DPAD_BTNS)) {
        const i = Number(idx);
        if (gp.buttons[i]?.pressed) {
          hatDir = dir;
          break;
        }
      }
    }

    if (hatDir !== prevHatDir) {
      if (prevHatDir && activeDir === prevHatDir) endPtzHold();
      if (hatDir) {
        const btn = padEl.querySelector(`[data-dir="${hatDir}"]`);
        startPtzHold(hatDir, btn);
      }
      prevHatDir = hatDir;
    } else if (!hatDir && prevHatDir) {
      if (activeDir === prevHatDir) endPtzHold();
      prevHatDir = null;
    }
  }

  function dirFromLeftStick(rawX, rawY) {
    const x = rawX;
    const y = -rawY;
    if (Math.hypot(x, y) < GP_STICK_THRESH) return null;
    if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'left' : 'right';
    return y > 0 ? 'up' : 'down';
  }

  /** Grilla 3×3 al estilo teclado (9 arriba-derecha, 5 centro, 1 abajo-izq). */
  function zoneCellFromStick(rawX, rawY, thresh) {
    const x = rawX;
    const y = -rawY;
    if (Math.hypot(x, y) < thresh) return null;
    const edge = thresh * GP_ZONE_AXIS_FRAC;
    let row = 1;
    let col = 1;
    if (y > edge) row = 0;
    else if (y < -edge) row = 2;
    if (x > edge) col = 2;
    else if (x < -edge) col = 0;
    return { row, col, zoneId: ZONE_ROWS[row][col] };
  }

  async function goGamepadZone(zoneId) {
    if (!zoneId || setupMode) return;
    flashZoneCell(zoneId);
    const z = zones.find((x) => x.id === zoneId);
    if (!z?.configured) {
      setStatus(`Zona ${ZONE_PHONE_NUM[zoneId] || '?'} sin guardar`, true);
      return;
    }
    await gotoZone(zoneId);
  }

  function stepZoneByDir(dir) {
    let { row, col } = currentZoneCell;
    if (dir === 'up') row -= 1;
    if (dir === 'down') row += 1;
    if (dir === 'left') col -= 1;
    if (dir === 'right') col += 1;
    row = Math.max(0, Math.min(2, row));
    col = Math.max(0, Math.min(2, col));
    const zoneId = ZONE_ROWS[row][col];
    setCurrentZoneCell(row, col, zoneId);
    const now = Date.now();
    if (now - lastZoneGotoAt < 450) return;
    lastZoneGotoAt = now;
    goGamepadZone(zoneId).catch((err) => setStatus(err.message, true));
  }

  function handleRightStickZones(gp) {
    const cell = zoneCellFromStick(
      gp.axes[GP_RIGHT_X] ?? 0,
      gp.axes[GP_RIGHT_Y] ?? 0,
      GP_RIGHT_STICK_THRESH,
    );
    const sector = cell ? `${cell.row},${cell.col}` : null;
    if (sector === prevRightStickSector) return;
    prevRightStickSector = sector;
    if (!cell) return;

    setCurrentZoneCell(cell.row, cell.col, cell.zoneId);
    const now = Date.now();
    if (now - lastRightZoneGotoAt < 350) return;
    lastRightZoneGotoAt = now;
    goGamepadZone(cell.zoneId).catch((err) => setStatus(err.message, true));
  }

  function handleLeftStickZones(gp) {
    const r3 = Boolean(gp.buttons[GP_BTN_R3]?.pressed);
    if (r3 && !prevR3Pressed) {
      prevR3Pressed = true;
      setCurrentZoneCell(1, 1, 'neut_cen');
      const now = Date.now();
      if (now - lastZoneGotoAt > 400) {
        lastZoneGotoAt = now;
        goGamepadZone('neut_cen').catch((err) => setStatus(err.message, true));
      }
    }
    if (!r3) prevR3Pressed = false;

    const dir = dirFromLeftStick(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
    if (dir === prevLeftStickDir) return;
    const was = prevLeftStickDir;
    prevLeftStickDir = dir;
    if (dir && was === null) stepZoneByDir(dir);
  }

  function pollGamepad() {
    if (!gamepadArmed) return;
    wakeGamepadApi();
    const gp = pickGamepad();

    if (!gp) {
      gamepadReady = false;
      if (gamepadStickActive) endPtzHold();
      if (!gamepadWaitingMsg) {
        gamepadWaitingMsg = true;
        setStatus('Pulsá cualquier botón del PS4 (▶ o R2)', true);
      }
      gamepadLoopId = requestAnimationFrame(pollGamepad);
      return;
    }

    gamepadWaitingMsg = false;
    if (!gamepadReady) {
      gamepadReady = true;
      setStatus(`Listo: ${gp.id || 'joystick'}`);
    }

    handleRightStickZones(gp);
    handleGamepadDpad(gp);
    if (!prevHatDir && gamepadStickActive) endPtzHold();
    handleLeftStickZones(gp);

    gamepadLoopId = requestAnimationFrame(pollGamepad);
  }

  function setGamepadArmed(on) {
    if (!on && !gamepadArmed) return;
    if (!navigator.getGamepads) {
      setStatus('Este navegador no soporta joystick', true);
      return;
    }
    if (on && kbdArmed) setKbdArmed(false);
    gamepadArmed = on;
    gamepadToggle?.classList.toggle('is-active', on);
    gamepadToggle?.setAttribute('aria-pressed', on ? 'true' : 'false');
    rinkRoot?.classList.toggle('tapo-rink--kbd-armed', on || kbdArmed);
    if (!on) {
      stopGamepadLoop();
      gamepadReady = false;
      gamepadWaitingMsg = false;
      lockedGamepadIndex = -1;
      prevHatDir = null;
      prevLeftStickDir = null;
      prevRightStickSector = null;
      prevR3Pressed = false;
      currentZoneCell = { row: 1, col: 1 };
      endPtzHold();
      if (!kbdArmed && !statusEl.classList.contains('tapo-rink__status--err')) setStatus('');
    } else {
      wakeGamepadApi();
      setStatus('Cruceta=mover · Stick izq.=cambiar zona · R3=zona 5');
      document.activeElement?.blur?.();
      pollGamepad();
    }
    syncCtrlHint();
  }

  function onGamepadWakeEvent() {
    if (!gamepadArmed) return;
    wakeGamepadApi();
  }

  gamepadToggle?.addEventListener('click', () => {
    if (!host.classList.contains('hidden') && rinkRoot?.classList.contains('tapo-rink--collapsed')) {
      setExpanded(true);
    }
    wakeGamepadApi();
    setGamepadArmed(!gamepadArmed);
  });

  window.addEventListener('gamepadconnected', (e) => {
    lockedGamepadIndex = e.gamepad?.index ?? -1;
    if (gamepadArmed) setStatus(`Conectado: ${e.gamepad?.id || 'joystick'}`);
  });
  window.addEventListener('gamepaddisconnected', () => {
    lockedGamepadIndex = -1;
    gamepadReady = false;
    if (gamepadArmed) {
      setStatus('Joystick desconectado', true);
      endPtzHold();
    }
  });
  window.addEventListener('mousedown', onGamepadWakeEvent, true);
  window.addEventListener('keydown', onGamepadWakeEvent, true);

  async function startPtzHold(dir, btn) {
    const hold = ptzHoldId;
    const padBtn = btn || padEl.querySelector(`[data-dir="${dir}"]`);
    if (activeDir === dir && activeBtn === padBtn) return;
    if (activeBtn) activeBtn.classList.remove('is-active');
    activeDir = dir;
    activeBtn = padBtn;
    padBtn?.classList.add('is-active');
    try {
      await ptzApi('/camera/ptz', MOVES[dir]);
    } catch (err) {
      setStatus(err.message, true);
      await endPtzHold();
      return;
    }
    if (hold !== ptzHoldId) {
      try {
        await ptzApi('/camera/stop');
      } catch (_) { /* noop */ }
    }
  }

  function onPtzPress(e, dir, btn) {
    e.preventDefault();
    e.stopPropagation();
    dragPointerId = e.pointerId ?? 'mouse';
    try {
      btn.setPointerCapture?.(e.pointerId);
    } catch (_) { /* noop */ }
    startPtzHold(dir, btn);
  }

  function onPtzRelease(e) {
    if (dragPointerId === null) return;
    if (
      e?.pointerId != null &&
      typeof dragPointerId === 'number' &&
      e.pointerId !== dragPointerId
    ) {
      return;
    }
    try {
      if (e?.pointerId != null) padEl.releasePointerCapture?.(e.pointerId);
    } catch (_) { /* noop */ }
    endPtzHold();
  }

  function bindPtzButton(btn) {
    const dir = btn.dataset.dir;
    if (!dir) return;

    btn.addEventListener('pointerdown', (e) => onPtzPress(e, dir, btn));
    btn.addEventListener('pointerup', onPtzRelease);
    btn.addEventListener('pointercancel', onPtzRelease);
    btn.addEventListener('pointerleave', (e) => {
      if (activeBtn === btn) onPtzRelease(e);
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  padEl.querySelectorAll('[data-dir]').forEach(bindPtzButton);

  padEl.addEventListener('pointermove', (e) => {
    if (dragPointerId === null) return;
    if (e.pointerId != null && dragPointerId !== e.pointerId) return;
    const hit = dirAtPoint(e.clientX, e.clientY);
    if (hit?.btn?.dataset?.dir) {
      startPtzHold(hit.dir, hit.btn);
    } else if (activeDir) {
      onPtzRelease(e);
    }
  });

  const stopBtn = padEl.querySelector('[data-tapo-stop]');
  if (stopBtn) {
    const onStop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPtzRelease(e);
    };
    stopBtn.addEventListener('pointerdown', onStop);
    stopBtn.addEventListener('click', onStop);
  }

  window.addEventListener('pointerup', onPtzRelease, true);
  window.addEventListener('pointercancel', onPtzRelease, true);
  window.addEventListener('mouseup', onPtzRelease, true);
  window.addEventListener('blur', () => endPtzHold(), true);

  const streamInput = document.getElementById('livecapture-stream-url');
  streamInput?.addEventListener('input', updateVisibility);
  streamInput?.addEventListener('change', updateVisibility);
  document.getElementById('livecapture-source-picker')?.addEventListener('click', () => {
    setTimeout(updateVisibility, 0);
  });

  if (isLocalDev() && streamInput && !streamInput.value.trim()) {
    streamInput.placeholder = 'http://127.0.0.1:8888/tapo/';
  }

  updateVisibility();
  setInterval(() => {
    if (!host.classList.contains('hidden')) checkPtzServer();
  }, 10000);
  return { refresh: updateVisibility };
}
