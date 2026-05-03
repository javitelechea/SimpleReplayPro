/**
 * API de depuración opcional para consola / harness (no producción por defecto).
 *
 * Se activa solo si:
 * - hostname es localhost / 127.0.0.1 / ::1, o
 * - URL incluye ?srDebug=1 (útil en previews desplegados).
 *
 * Fase 3–4: grabación, snapshot/DVR, consolidación y video local.
 */

import {
  startLiveRecording,
  stopLiveRecording,
  listVideoInputs,
  isLiveRecordingActive,
  getLastStoppedSession,
  snapshotReview,
} from './livecapture/liveRecordingController.js';
import { promoteStoppedSessionToLocal } from './livecapture/sessionConsolidate.js';

/**
 * @returns {boolean}
 */
export function isSimpleReplayDevEnabled() {
  if (typeof window === 'undefined' || typeof location === 'undefined') return false;
  const host = String(location.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
  try {
    return new URLSearchParams(location.search).get('srDebug') === '1';
  } catch {
    return false;
  }
}

/**
 * Expone un objeto namespaced en window solo cuando el gate permite.
 * @param {{ YTPlayer: object, liveFacade: import('./livecapture/LiveCaptureFacade.js').LiveCaptureFacade|null, AppState?: object }} api
 */
export function attachSimpleReplayDevApi(api) {
  if (!isSimpleReplayDevEnabled()) return;

  const { YTPlayer, liveFacade, AppState } = api;

  /**
   * Clips con created_at >= este ms se consideran de la corrida LiveCapture/harness actual.
   * Se ancla en enterLiveCapture; startCapture solo si aún no hay ancla.
   */
  let _harnessClipEpochMs = null;

  function touchHarnessClipEpoch(reason) {
    _harnessClipEpochMs = Date.now();
    console.info('[sr/dev] Ventana clips harness desde', new Date(_harnessClipEpochMs).toISOString(), '—', reason);
  }

  /** Partido actual + ventana temporal (excluye clips demo / sesiones anteriores). */
  function harnessSortedClips() {
    if (!AppState) return [];
    const gid = AppState.get('currentGameId');
    let clips = [...(AppState.get('clips') || [])].filter((c) => c && c.game_id === gid);
    if (_harnessClipEpochMs != null) {
      clips = clips.filter((c) => {
        const ts = Date.parse(c.created_at || '');
        return Number.isFinite(ts) && ts >= _harnessClipEpochMs;
      });
    }
    return clips.sort((a, b) => (a.t_sec || 0) - (b.t_sec || 0));
  }

  function ensureClipHarness() {
    if (!AppState || typeof AppState.get !== 'function' || typeof AppState.addGame !== 'function') {
      console.warn('[sr/dev] AppState no está expuesto en la dev API — no se pueden crear clips.');
      return false;
    }
    let gid = AppState.get('currentGameId');
    const games = AppState.get('games') || [];
    if (!gid && games.length) {
      AppState.setCurrentGame(games[0].id);
      gid = AppState.get('currentGameId');
    }
    if (!gid) {
      const g = AppState.addGame('LiveCapture clip harness', '', null);
      AppState.setCurrentGame(g.id);
    }
    const tagTypes = AppState.get('tagTypes');
    if (!tagTypes?.length && typeof AppState.addTagType === 'function') {
      AppState.addTagType({
        key: 'lc_harness',
        label: 'LC harness',
        pre_sec: 2,
        post_sec: 5,
      });
    }
    return true;
  }

  const dev = {
    YTPlayer,
    liveFacade,
    AppState: AppState ?? null,

    /** @param {string} [sessionId] */
    enterLiveCapture(sessionId = 'dev-test') {
      if (!YTPlayer.loadLiveCapture) {
        console.warn('[sr/dev] loadLiveCapture no disponible');
        return;
      }
      YTPlayer.loadLiveCapture({ sessionId });
      touchHarnessClipEpoch('enterLiveCapture');
    },

    getSourceType() {
      return YTPlayer.getSourceType?.() ?? null;
    },

    loadYouTube(videoId) {
      YTPlayer.loadVideo?.(videoId);
    },

    loadLocalVideo(url, file) {
      YTPlayer.loadLocalVideo?.(url, file ?? null);
    },

    /**
     * Inicia MediaRecorder + segmentos (OPFS si hay) + preview.
     * Si no estás en liveCapture, hace loadLiveCapture con sessionId nuevo.
     * @param {{ sessionId?: string, deviceId?: string, resolution?: '720'|'1080'|'any', mimeType?: string, timesliceMs?: number }} [opts]
     */
    async startCapture(opts = {}) {
      if (!liveFacade) {
        console.warn('[sr/dev] liveFacade null — no se pudo iniciar grabación');
        return;
      }

      let sid = opts.sessionId;
      if (YTPlayer.getSourceType?.() !== 'liveCapture') {
        sid = sid || `session-${Date.now()}`;
        YTPlayer.loadLiveCapture?.({ sessionId: sid });
      }

      try {
        await startLiveRecording({
          facade: liveFacade,
          sessionId: opts.sessionId ?? liveFacade.getSessionId() ?? sid,
          deviceId: opts.deviceId,
          resolution: opts.resolution ?? '720',
          mimeType: opts.mimeType,
          timesliceMs: opts.timesliceMs,
        });
        if (_harnessClipEpochMs == null) {
          touchHarnessClipEpoch('startCapture (sin enterLiveCapture previo)');
        }
        console.info('[sr/dev] Grabación iniciada — sessionId:', liveFacade.getSessionId());
      } catch (e) {
        console.error('[sr/dev] startCapture:', e?.message || e);
      }
    },

    /** Detiene recorder y cámara; segmentos quedan en OPFS / memoria. */
    async stopCapture() {
      try {
        const r = await stopLiveRecording();
        if (r) console.info('[sr/dev] Grabación detenida:', r);
        else console.info('[sr/dev] No había grabación activa');
      } catch (e) {
        console.error('[sr/dev] stopCapture:', e?.message || e);
      }
    },

    recordingActive() {
      return isLiveRecordingActive();
    },

    /** Tras permiso de cámara, suele mostrar labels reales. */
    async listCameras() {
      const list = await listVideoInputs();
      console.table(
        list.map((d, i) => ({
          i,
          label: d.label || '(sin etiqueta — pedí permiso primero)',
          deviceId: d.deviceId?.slice(0, 16) + '…',
        }))
      );
      return list;
    },

    /**
     * Durante la grabación: une segmentos hasta ahora y muestra replay (la captura sigue).
     * Volvé con .backToLive().
     */
    async reviewSnapshot() {
      if (!liveFacade) {
        console.warn('[sr/dev] liveFacade null');
        return null;
      }
      try {
        const r = await snapshotReview(liveFacade);
        console.info('[sr/dev] Modo revisión — duración replay ~', r?.realDuration, 's');
        return r;
      } catch (e) {
        console.error('[sr/dev] reviewSnapshot:', e?.message || e);
        return null;
      }
    },

    /** Sale del replay y vuelve al preview en vivo (grabación no se detiene). */
    backToLive() {
      liveFacade?.goLive?.();
      console.info('[sr/dev] Vivo (preview)');
    },

    /**
     * Tras stopCapture: consolida OPFS+memoria → final.webm, manifest, y carga como video local.
     * @param {{ download?: boolean }} [opts]
     */
    async finalizeLocal(opts = {}) {
      if (isLiveRecordingActive()) {
        console.warn('[sr/dev] Detené primero con stopCapture()');
        return null;
      }
      const meta = getLastStoppedSession();
      if (!meta) {
        console.warn('[sr/dev] No hay sesión detenida (ejecutá stopCapture antes)');
        return null;
      }
      try {
        const out = await promoteStoppedSessionToLocal(YTPlayer, meta, opts);
        if (out) {
          console.info('[sr/dev] Promoción local OK — sessionId:', out.sessionId, '→', out.file.name);
        }
        return out;
      } catch (e) {
        console.error('[sr/dev] finalizeLocal:', e?.message || e);
        return null;
      }
    },

    /** Metadatos de la última sesión tras stopCapture (consolidación). */
    lastStoppedSession() {
      return getLastStoppedSession();
    },

    /**
     * Estado rápido del eje temporal (vivo = SessionClock tras startCapture; revisión = tiempo del replay).
     */
    peekPlayhead() {
      const row = {
        source: YTPlayer.getSourceType?.() ?? null,
        time_sec: YTPlayer.getCurrentTime?.() ?? null,
        duration_sec: YTPlayer.getDuration?.() ?? null,
        liveMode: liveFacade?.getMode?.() ?? null,
        recording: isLiveRecordingActive(),
      };
      console.info('[sr/dev] playhead', row);
      return row;
    },

    /**
     * Crea un clip en el partido actual usando el tiempo de playhead (mismo criterio que la botonera).
     * En vivo: reloj de sesión. En revisión (DVR): currentTime del replay = segundos desde el inicio del WebM acumulado.
     * @param {string} [tagTypeId] — default: primer tag del proyecto
     * @returns {object|null}
     */
    tagAtPlayhead(tagTypeId) {
      if (!ensureClipHarness()) return null;
      if (_harnessClipEpochMs == null) {
        touchHarnessClipEpoch('primer tagAtPlayhead');
      }
      const tRaw = YTPlayer.getCurrentTime?.() ?? 0;
      const tSec = Math.round(Math.max(0, tRaw) * 1000) / 1000;
      const mode = liveFacade?.getMode?.() ?? null;
      let tid = tagTypeId;
      if (!tid) {
        const tags = AppState.get('tagTypes');
        tid = tags?.[0]?.id;
      }
      if (!tid) {
        console.warn('[sr/dev] No hay tag types para clip.');
        return null;
      }
      const clip = AppState.addClip(tid, tSec);
      if (!clip) {
        console.warn('[sr/dev] addClip devolvió null (tag inválido o ventana cero).');
        return null;
      }
      const tag = AppState.getTagType(tid);
      console.info('[sr/dev] Clip creado', {
        id: clip.id,
        t_sec: clip.t_sec,
        start_sec: clip.start_sec,
        end_sec: clip.end_sec,
        tag: tag?.label,
        liveCaptureMode: mode,
        recording: isLiveRecordingActive(),
        source: YTPlayer.getSourceType?.(),
      });
      return clip;
    },

    /** Ventana temporal usada para filtrar clips (ms desde epoch JS). */
    harnessClipWindow() {
      if (_harnessClipEpochMs == null) return null;
      return {
        epochMs: _harnessClipEpochMs,
        sinceIso: new Date(_harnessClipEpochMs).toISOString(),
      };
    },

    /** Nueva corrida: excluye todo clip con created_at anterior a ahora (p. ej. otro ensayo en el mismo partido). */
    resetHarnessClipWindow() {
      touchHarnessClipEpoch('resetHarnessClipWindow');
    },

    /** Clips del partido actual en la ventana harness (sin clips demo previos). */
    listHarnessClips() {
      if (!AppState) return [];
      if (_harnessClipEpochMs == null) {
        touchHarnessClipEpoch('primer listHarnessClips');
      }
      const clips = harnessSortedClips();
      console.info('[sr/dev] Clips en ventana:', clips.length, '| partido:', AppState.get('currentGameId')?.slice?.(0, 12) ?? AppState.get('currentGameId'));
      const rows = clips.map((c, i) => {
        const tag = AppState.getTagType(c.tag_type_id);
        return {
          i,
          label: tag?.label ?? c.tag_type_id,
          t_sec: c.t_sec,
          start_sec: c.start_sec,
          end_sec: c.end_sec,
          id: c.id?.slice?.(0, 10) ?? c.id,
        };
      });
      console.table(rows);
      return clips;
    },

    /**
     * Tras finalizar a video local: para cada clip, hace seek a t_sec y compara con getCurrentTime (delta suele quedar bajo 100 ms).
     * @param {{ settleMs?: number }} [opts]
     */
    async verifyHarnessClips(opts = {}) {
      if (!YTPlayer.getCurrentTime || !YTPlayer.seekTo) {
        console.warn('[sr/dev] YTPlayer sin seek/getCurrentTime');
        return [];
      }
      if (YTPlayer.getSourceType?.() !== 'local') {
        console.warn('[sr/dev] Abrí el video local primero (finalizeLocal). Fuente actual:', YTPlayer.getSourceType?.());
      }
      if (!AppState) return [];
      if (_harnessClipEpochMs == null) {
        console.warn('[sr/dev] Sin ventana temporal — ejecutá enterLiveCapture(), listHarnessClips() o tagAtPlayhead() antes.');
      }
      YTPlayer.clearClipEnd?.();
      YTPlayer.pause?.();
      const settleMs = opts.settleMs ?? 400;
      const clips = harnessSortedClips();
      const out = [];
      for (const c of clips) {
        YTPlayer.seekTo(c.t_sec);
        await new Promise((r) => setTimeout(r, settleMs));
        const actual = YTPlayer.getCurrentTime();
        out.push({
          t_sec_saved: c.t_sec,
          player_sec: Math.round(actual * 1000) / 1000,
          delta_ms: Math.round((actual - c.t_sec) * 1000),
        });
      }
      console.table(out);
      const maxAbs = out.reduce((m, r) => Math.max(m, Math.abs(r.delta_ms)), 0);
      console.info('[sr/dev] verifyHarnessClips — clips en ventana:', clips.length, '— max |delta| ms:', maxAbs);
      return out;
    },

    /**
     * Reproduce la ventana del clip (índice en listHarnessClips ordenado por t_sec).
     * @param {number} index
     */
    playHarnessClip(index) {
      const clips = harnessSortedClips();
      const c = clips[index];
      if (!c) {
        console.warn('[sr/dev] Sin clip en índice', index);
        return;
      }
      YTPlayer.playClip?.(c.start_sec, c.end_sec);
      console.info('[sr/dev] playClip', { index, start_sec: c.start_sec, end_sec: c.end_sec, t_sec: c.t_sec });
    },

    help() {
      console.info(`
[SimpleReplay dev] window.__SIMPLE_REPLAY_DEV__

Modo captura:
  .enterLiveCapture('dev-test')
  .startCapture({ resolution: '720' })
  .stopCapture()
  .recordingActive()

Fase 4 — DVR / consolidación:
  .reviewSnapshot()
  .backToLive()
  .finalizeLocal({ download: true })

Clips / eje temporal (sin UI):
  .peekPlayhead()
  .tagAtPlayhead()              // opcional: tagTypeId
  .listHarnessClips()          // solo clips del partido actual desde enterLiveCapture / ventana
  .harnessClipWindow()
  .resetHarnessClipWindow()     // nueva corrida, mismo partido
  .finalizeLocal()              // video local
  .verifyHarnessClips()         // solo clips de la ventana
  .playHarnessClip(0)

Utilidades:
  .listCameras()
  .lastStoppedSession()
  .getSourceType()
  .loadYouTube('VIDEO_ID')
  .loadLocalVideo(objectUrl, file?)
  .AppState  .YTPlayer  .liveFacade`);
    },
  };

  window.__SIMPLE_REPLAY_DEV__ = dev;
  console.info('SimpleReplay DEV API attached');
  console.info('[SimpleReplay dev] __SIMPLE_REPLAY_DEV__.help() — localhost o ?srDebug=1');
}
