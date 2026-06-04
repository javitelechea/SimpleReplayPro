/**
 * Importación XML estilo NacSport / análisis por equipos (ej. Holanda - Argelia).
 * Formato: SORT_INFO + ALL_INSTANCES (code "Equipo - Acción", offsets) + ROWS con sort_order.
 * No altera el flujo SportCode clásico (Start + instancias sin SORT_INFO).
 */

const SKIP_INSTANCE_CODES = new Set(['Offsets']);
const SKIP_ROW_CODES = new Set(['Offsets']);

/**
 * @param {Document} xmlDoc
 * @returns {boolean}
 */
export function isExtendedSportXml(xmlDoc) {
  if (!xmlDoc?.querySelector?.('SORT_INFO')) return false;
  const instances = xmlDoc.querySelectorAll('ALL_INSTANCES > instance');
  for (const inst of instances) {
    const code = inst.querySelector('code')?.textContent?.trim();
    if (code === 'Offsets') return true;
  }
  return false;
}

/**
 * Alinea con el clip Start del proyecto usando "Comienzo primer tiempo" (u offset mínimo).
 * @param {Document} xmlDoc
 * @param {{ t_sec?: number } | null | undefined} appStartClip
 * @returns {number}
 */
export function resolveExtendedSportXmlOffset(xmlDoc, appStartClip) {
  const instances = xmlDoc.querySelectorAll('ALL_INSTANCES > instance');
  let kickoffSec = null;

  for (const inst of instances) {
    const code = inst.querySelector('code')?.textContent?.trim();
    if (code !== 'Offsets') continue;
    const labelText = inst.querySelector('label > text')?.textContent?.trim() || '';
    if (/comienzo\s+primer\s+tiempo/i.test(labelText)) {
      kickoffSec = parseFloat(inst.querySelector('start')?.textContent || '0');
      break;
    }
  }

  if (kickoffSec === null) {
    let min = null;
    for (const inst of instances) {
      if (inst.querySelector('code')?.textContent?.trim() !== 'Offsets') continue;
      const s = parseFloat(inst.querySelector('start')?.textContent || 'NaN');
      if (!Number.isFinite(s)) continue;
      if (min === null || s < min) min = s;
    }
    kickoffSec = min;
  }

  if (kickoffSec === null || !appStartClip || !Number.isFinite(appStartClip.t_sec)) {
    return 0;
  }
  return appStartClip.t_sec - kickoffSec;
}

/**
 * @param {string} r
 * @param {string} g
 * @param {string} b
 * @returns {'top' | 'bottom'}
 */
function rowFromRowColors(r, g, b) {
  const gi = parseInt(g, 10) || 0;
  const ri = parseInt(r, 10) || 0;
  if (gi >= 30000 && gi <= 36000 && ri < 4096) return 'bottom';
  if (gi >= 30000 && gi <= 36000) return 'top';
  return 'top';
}

/**
 * @param {Document} xmlDoc
 * @param {number} offset
 * @param {{ state: object, DemoData: object, emit: Function, addActivity: Function }} ctx
 * @returns {number | false}
 */
export function importExtendedSportXmlDocument(xmlDoc, offset, ctx) {
  const { state, DemoData, emit, addActivity } = ctx;
  if (!state.currentGameId) return false;

  const mergedTagTypes = [...state.tagTypes];
  const mergedClips = [...state.clips];
  const makeId = (prefix) =>
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const codeToTagMap = {};

  const ensureTagForCode = (code, rowHint = 'top') => {
    let existingTag = mergedTagTypes.find((t) => t.label === code);
    if (!existingTag) {
      existingTag = {
        id: makeId('tag'),
        key:
          code.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || makeId('tagkey'),
        label: code,
        pre_sec: 5,
        post_sec: 5,
        row: rowHint,
        isHidden: true,
        captureMode: 'fixed',
        order: mergedTagTypes.length,
      };
      mergedTagTypes.push(existingTag);
    }
    return existingTag;
  };

  const rows = xmlDoc.querySelectorAll('ROWS > row');
  rows.forEach((row) => {
    const codeEl = row.querySelector('code');
    if (!codeEl) return;
    const code = codeEl.textContent.trim();
    if (SKIP_ROW_CODES.has(code)) return;
    const r = row.querySelector('R')?.textContent ?? '0';
    const g = row.querySelector('G')?.textContent ?? '0';
    const b = row.querySelector('B')?.textContent ?? '0';
    const ensured = ensureTagForCode(code, rowFromRowColors(r, g, b));
    codeToTagMap[code] = ensured.id;
  });

  const instances = xmlDoc.querySelectorAll('ALL_INSTANCES > instance');
  let clipCount = 0;

  instances.forEach((inst) => {
    const startEl = inst.querySelector('start');
    const endEl = inst.querySelector('end');
    const codeEl = inst.querySelector('code');
    if (!startEl || !endEl || !codeEl) return;

    const code = codeEl.textContent.trim();
    if (SKIP_INSTANCE_CODES.has(code)) return;

    let tagId = codeToTagMap[code];
    if (!tagId) {
      const teamRow = /^Algeria\s/i.test(code) ? 'bottom' : /^Netherlands\s/i.test(code) ? 'top' : 'top';
      const ensured = ensureTagForCode(code, teamRow);
      codeToTagMap[code] = ensured.id;
      tagId = ensured.id;
    }

    const startSec = (parseFloat(startEl.textContent) || 0) + offset;
    const endSec = (parseFloat(endEl.textContent) || 0) + offset;
    const normalizedEnd = Math.max(endSec, startSec + 0.1);

    mergedClips.push({
      id: makeId('clip'),
      game_id: state.currentGameId,
      tag_type_id: tagId,
      t_sec: startSec,
      start_sec: startSec,
      end_sec: normalizedEnd,
      created_by: state.userId,
      created_at: new Date().toISOString(),
    });
    clipCount += 1;
  });

  const mergedProject = {
    games: [...state.games],
    clips: mergedClips,
    playlists: [...state.playlists],
    playlistItems: { ...state.playlistItems },
    clipFlags: { ...state.clipFlags },
    tagTypes: mergedTagTypes,
  };
  DemoData.restore(mergedProject);
  DemoData.restoreTagTypes(mergedTagTypes);

  state.tagTypes = mergedTagTypes;
  state.clips = DemoData.getClipsForGame(state.currentGameId);
  state.playlists = DemoData.getPlaylistsForGame(state.currentGameId);
  state.playlistItems = {};
  state.playlists.forEach((pl) => {
    state.playlistItems[pl.id] = DemoData.getPlaylistItems(pl.id);
  });
  state.clipFlags = {};
  state.clips.forEach((c) => {
    state.clipFlags[c.id] = DemoData.getClipFlags(c.id);
  });

  emit('tagTypesUpdated');
  emit('clipsUpdated');
  addActivity('xml_import', { count: clipCount, format: 'extended_sport' });

  return clipCount;
}
