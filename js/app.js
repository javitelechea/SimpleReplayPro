/* ═══════════════════════════════════════════
   SimpleReplay — Main Application
   Event wiring, keyboard shortcuts, init
   ═══════════════════════════════════════════ */

import { AppState } from './state.js';
import { UI } from './ui.js';
import { DemoData } from './demoData.js';
import { FirebaseData } from './firebaseData.js';
import { YTPlayer } from './youtubePlayer.js';
import { Timeline } from './timeline.js';
import { DrawingTool } from './drawing.js';
import { ExportManager } from './export.js';
import { onAuthChange, loginWithGoogle, logout, waitForAuthReady, getCurrentUser, getUserDoc, setLastProjectForUser } from './auth.js';
import { FEATURES, resolveEffectivePlan, resolveFeaturesForUser } from './features.js';
import { toMillis } from './access.js';
import { ButtonboardTemplates } from './buttonboardTemplates.js';
import { createSessionGuard } from './sessionGuard.js';
import { PopoutController } from './popoutController.js';
import { LiveCaptureFacade } from './livecapture/LiveCaptureFacade.js';
import {
    startLiveRecording,
    startLivePreview,
    stopLivePreview,
    isLivePreviewActive,
    stopLiveRecording,
    pauseLiveRecording,
    resumeLiveRecording,
    isLiveRecordingActive,
    isLiveRecordingPaused,
    getLastStoppedSession,
    listVideoInputs,
} from './livecapture/liveRecordingController.js';
import { promoteStoppedSessionToLocal } from './livecapture/sessionConsolidate.js';
import { canRunLiveCapture } from './livecapture/index.js';
import { attachSimpleReplayDevApi } from './simpleReplayDev.js';

(function () {
    'use strict';

    const $ = UI.$;
    let latestUserDoc = null;
    let authMenuWired = false;
    let _localVideoFileForCurrentGame = null;
    let _mainAudioBeforePopout = null;
    /** Ref para crear proyecto «Captura» antes de que existan otros puntos de entrada. */
    /** @type {import('./livecapture/LiveCaptureFacade.js').LiveCaptureFacade|null} */
    let _liveCaptureFacadeRef = null;
    /** Ref desde `wireLiveCaptureAnalyzeTab`: cambiar pestaña Clips / Captura en vivo. */
    /** @type {((which: 'clips' | 'livecapture') => void) | null} */
    let _switchAnalyzeTabRef = null;
    let _liveProbeLastDuration = 0;
    let _liveProbeLastTs = 0;
    let _liveDurationGrowthHits = 0;
    let _liveDetectedSticky = false;
    let _liveControlPinned = false;
    const LIVE_EDGE_THRESHOLD_SEC = 120;
    const SEEK_STEP_KEY = 'sr_seek_step_sec';
    const SEEK_STEP_SHIFT_KEY = 'sr_seek_step_shift_sec';
    const DEFAULT_SEEK_STEP = 5;
    const DEFAULT_SEEK_STEP_SHIFT = 1;
    const AUTO_SAVE_ENABLED_KEY = 'sr_auto_save_enabled';
    const AUTO_SAVE_INTERVAL_MS = 60000;
    const DEFAULT_SHORTCUTS = {
        playPause: 'Space',
        seekLeft: 'ArrowLeft',
        seekRight: 'ArrowRight',
        seekLeftFast: 'Shift+ArrowLeft',
        seekRightFast: 'Shift+ArrowRight',
    };
    const QUICK_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u'];
    let _quickClipMenuOpen = false;
    let _quickPlaylistPickerOpen = false;
    let _autoSaveTimer = null;
    let _autoSaveInFlight = false;
    let _autoSaveNudgeShown = false;
    let _sessionConflictLocked = false;
    const SessionGuard = createSessionGuard({
        onConflict: async () => {
            _sessionConflictLocked = true;
            UI.showModal('modal-session-conflict');
            UI.toast('Tu sesión fue reemplazada en otro dispositivo', 'error');
            try {
                await AppState.saveToCloud();
            } catch (_) { /* best effort */ }
        },
        onError: (e) => {
            console.warn('Session guard error:', e);
        },
    });

    function getLastClip() {
        const clips = AppState.get('clips') || [];
        if (!clips.length) return null;
        const withTs = clips.filter(c => c && c.created_at);
        if (withTs.length) {
            return withTs.reduce((acc, c) => {
                const accTs = Date.parse(acc.created_at || 0) || 0;
                const cTs = Date.parse(c.created_at || 0) || 0;
                return cTs >= accTs ? c : acc;
            }, withTs[0]);
        }
        // Fallback for legacy clips without created_at
        return clips[clips.length - 1];
    }

    function closeQuickClipMenu() {
        const menu = $('#quick-clip-menu');
        if (!menu) return;
        menu.classList.add('hidden');
        menu.setAttribute('aria-hidden', 'true');
        _quickClipMenuOpen = false;
        _quickPlaylistPickerOpen = false;
        $('#quick-playlist-picker')?.classList.add('hidden');
    }

    function refreshQuickClipMenu() {
        const clip = getLastClip();
        const meta = $('#quick-clip-meta');
        if (!clip) {
            if (meta) meta.textContent = 'Sin clip seleccionado';
            return;
        }
        if (meta) {
            const tag = AppState.getTagType(clip.tag_type_id);
            const label = tag ? tag.label : 'Clip';
            meta.textContent = `${label} · ${UI.formatTime(clip.start_sec)}-${UI.formatTime(clip.end_sec)}`;
        }
        const flags = AppState.getClipUserFlags(clip.id);
        [
            ['quick-flag-bueno', 'bueno'],
            ['quick-flag-acorregir', 'acorregir'],
            ['quick-flag-duda', 'duda'],
            ['quick-flag-importante', 'importante'],
        ].forEach(([id, flag]) => {
            const btn = $('#' + id);
            if (!btn) return;
            btn.classList.toggle('is-active', flags.includes(flag));
        });
    }

    function positionQuickClipMenu() {
        const menu = $('#quick-clip-menu');
        if (!menu || menu.classList.contains('hidden')) return;
        const list = $('#analyze-clip-list');
        const activeClipId = AppState.get('currentClipId');
        let anchorEl = null;
        if (list && activeClipId) {
            anchorEl = list.querySelector(`.clip-item[data-clip-id="${activeClipId}"]`);
        }
        if (!anchorEl && list) {
            const lastClip = getLastClip();
            if (lastClip) {
                anchorEl = list.querySelector(`.clip-item[data-clip-id="${lastClip.id}"]`);
            }
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 10;

        const menuRect = menu.getBoundingClientRect();
        const menuW = menuRect.width || 360;
        const menuH = menuRect.height || 56;

        let left = margin;
        let top = 78;

        if (anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            left = r.left;
            top = r.bottom + 6;
        }

        left = Math.max(margin, Math.min(left, vw - menuW - margin));
        top = Math.max(margin, Math.min(top, vh - menuH - margin));

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function openQuickClipMenu() {
        const mode = AppState.get('mode');
        if (mode !== 'analyze') return;
        const clip = getLastClip();
        if (!clip) {
            UI.toast('No hay clips para editar', 'info');
            return;
        }
        const menu = $('#quick-clip-menu');
        if (!menu) return;
        refreshQuickClipMenu();
        menu.classList.remove('hidden');
        menu.setAttribute('aria-hidden', 'false');
        _quickClipMenuOpen = true;
        _quickPlaylistPickerOpen = false;
        $('#quick-playlist-picker')?.classList.add('hidden');
        requestAnimationFrame(positionQuickClipMenu);
    }

    function addCurrentQuickClipToPlaylist(playlistId) {
        const clip = getLastClip();
        if (!clip || !playlistId) return;
        const items = AppState.get('playlistItems')[playlistId] || [];
        if (items.includes(clip.id)) {
            UI.toast('Ese clip ya está en la playlist', 'info');
            closeQuickClipMenu();
            return;
        }
        AppState.addClipToPlaylist(playlistId, clip.id);
        const pl = (AppState.get('playlists') || []).find(p => p.id === playlistId);
        UI.toast(`Enviado a ${pl ? pl.name : 'playlist'} ✅`, 'success');
        closeQuickClipMenu();
    }

    function refreshQuickPlaylistPicker() {
        const picker = $('#quick-playlist-picker');
        const listEl = $('#quick-playlist-list');
        if (!picker || !listEl) return;
        const clip = getLastClip();
        const playlists = getQuickPlaylists();
        if (!clip) {
            listEl.innerHTML = '<div class="quick-playlist-help">Sin clip activo.</div>';
            return;
        }
        if (!playlists.length) {
            listEl.innerHTML = '<div class="quick-playlist-help">No hay playlists. Creá una con N.</div>';
            return;
        }
        listEl.innerHTML = playlists.map((pl, idx) => {
            const hasClip = (AppState.get('playlistItems')[pl.id] || []).includes(clip.id);
            return `<button class="quick-playlist-item" data-playlist-id="${pl.id}" type="button"><span class="name">${idx + 1}. ${pl.name}</span><span class="${hasClip ? 'check' : 'num'}">${hasClip ? '✓' : idx + 1}</span></button>`;
        }).join('');
    }

    function getQuickPlaylists() {
        const playlists = (AppState.get('playlists') || []).slice();
        playlists.sort((a, b) =>
            String(a?.name || '').localeCompare(String(b?.name || ''), 'es', { sensitivity: 'base', numeric: true })
        );
        return playlists.slice(0, 9);
    }

    function toggleQuickPlaylistPicker(forceOpen = null) {
        const picker = $('#quick-playlist-picker');
        if (!picker) return;
        const open = forceOpen === null ? !_quickPlaylistPickerOpen : !!forceOpen;
        _quickPlaylistPickerOpen = open;
        picker.classList.toggle('hidden', !open);
        if (open) {
            refreshQuickPlaylistPicker();
            requestAnimationFrame(positionQuickClipMenu);
            $('#quick-playlist-new-name')?.focus();
        }
    }

    function createQuickPlaylistAndSend() {
        const input = $('#quick-playlist-new-name');
        const name = (input?.value || '').trim();
        if (!name) {
            UI.toast('Escribí un nombre de playlist', 'error');
            return;
        }
        const pl = AppState.addPlaylist(name);
        if (input) input.value = '';
        addCurrentQuickClipToPlaylist(pl.id);
    }

    function quickActionByKey(k) {
        const clip = getLastClip();
        if (!clip) return;
        const activePlaylistId = AppState.get('activePlaylistId');
        switch ((k || '').toLowerCase()) {
            case 'q': AppState.toggleFlag(clip.id, 'bueno'); break;
            case 'w': AppState.toggleFlag(clip.id, 'acorregir'); break;
            case 'e': AppState.toggleFlag(clip.id, 'duda'); break;
            case 'r': AppState.toggleFlag(clip.id, 'importante'); break;
            case 't': {
                const text = prompt('Comentario rápido para este clip:');
                if (!text || !text.trim()) break;
                const playlists = AppState.get('playlists') || [];
                const playlistId = activePlaylistId || (playlists[0] && playlists[0].id);
                if (!playlistId) {
                    UI.toast('Primero creá una playlist para usar chat', 'error');
                    break;
                }
                const name = (localStorage.getItem('sr_chat_name') || 'Analista').trim() || 'Analista';
                AppState.addComment(playlistId, clip.id, name, text.trim());
                UI.toast('Comentario agregado', 'success');
                break;
            }
            case 'y': toggleQuickPlaylistPicker(); break;
            case 'u':
                if (confirm('¿Eliminar el último clip?')) {
                    AppState.deleteClip(clip.id);
                    UI.toast('Clip eliminado', 'success');
                }
                break;
            default: return;
        }
        refreshQuickClipMenu();
    }

    function wireQuickClipMenu() {
        const menu = $('#quick-clip-menu');
        if (!menu || menu.dataset.wired) return;
        menu.dataset.wired = '1';
        $('#quick-flag-bueno')?.addEventListener('click', () => quickActionByKey('q'));
        $('#quick-flag-acorregir')?.addEventListener('click', () => quickActionByKey('w'));
        $('#quick-flag-duda')?.addEventListener('click', () => quickActionByKey('e'));
        $('#quick-flag-importante')?.addEventListener('click', () => quickActionByKey('r'));
        $('#quick-chat')?.addEventListener('click', () => quickActionByKey('t'));
        $('#quick-playlist')?.addEventListener('click', () => quickActionByKey('y'));
        $('#quick-delete')?.addEventListener('click', () => quickActionByKey('u'));
        $('#quick-playlist-create-btn')?.addEventListener('click', createQuickPlaylistAndSend);
        $('#quick-playlist-new-name')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                createQuickPlaylistAndSend();
            }
        });
        $('#quick-playlist-list')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.quick-playlist-item');
            if (!btn) return;
            addCurrentQuickClipToPlaylist(btn.dataset.playlistId);
        });

        document.addEventListener('click', (e) => {
            if (!_quickClipMenuOpen) return;
            if (!menu.contains(e.target)) closeQuickClipMenu();
        });
        window.addEventListener('resize', () => {
            if (_quickClipMenuOpen) positionQuickClipMenu();
        });
        window.addEventListener('scroll', () => {
            if (_quickClipMenuOpen) positionQuickClipMenu();
        }, true);
    }

    function getSeekStep(isShift) {
        const key = isShift ? SEEK_STEP_SHIFT_KEY : SEEK_STEP_KEY;
        const fallback = isShift ? DEFAULT_SEEK_STEP_SHIFT : DEFAULT_SEEK_STEP;
        const raw = Number(localStorage.getItem(key));
        if (!Number.isFinite(raw) || raw <= 0) return fallback;
        return Math.min(60, Math.max(1, Math.round(raw)));
    }

    function isAutoSaveEnabled() {
        return localStorage.getItem(AUTO_SAVE_ENABLED_KEY) === '1';
    }

    function setAutoSaveEnabled(enabled) {
        localStorage.setItem(AUTO_SAVE_ENABLED_KEY, enabled ? '1' : '0');
        syncAutoSaveMenuState();
    }

    function syncAutoSaveMenuState() {
        const btn = $('#btn-toggle-autosave');
        const state = $('#autosave-menu-state');
        const enabled = isAutoSaveEnabled();
        if (btn) {
            btn.classList.toggle('is-active', enabled);
            btn.title = enabled ? 'Desactivar auto-guardado' : 'Activar auto-guardado';
        }
        if (state) {
            state.textContent = enabled ? 'ON' : 'OFF';
            state.classList.toggle('is-on', enabled);
        }
    }

    function normalizeKeyName(key) {
        if (key === ' ') return 'Space';
        if (key === 'Spacebar') return 'Space';
        if (key.length === 1) return key.toUpperCase();
        return key;
    }

    function eventToShortcut(e) {
        const key = normalizeKeyName(e.key);
        if (!key || ['Shift', 'Control', 'Meta', 'Alt'].includes(key)) return '';
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.metaKey) mods.push('Meta');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        return mods.length ? `${mods.join('+')}+${key}` : key;
    }

    function getShortcut(action) {
        return DEFAULT_SHORTCUTS[action];
    }

    function matchesShortcut(e, action) {
        return eventToShortcut(e) === getShortcut(action);
    }

    function openPreferencesModal() {
        const modal = $('#modal-preferences');
        if (!modal) return;
        $('#pref-seek-step').value = String(getSeekStep(false));
        $('#pref-seek-step-shift').value = String(getSeekStep(true));
        $('#pref-auto-save-enabled').checked = isAutoSaveEnabled();
        UI.showModal('modal-preferences');
    }

    function closePreferencesModal() {
        UI.hideModal('modal-preferences');
    }

    function parseStepInput(v, fallback) {
        const n = Number(String(v || '').replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) return fallback;
        return Math.min(60, Math.max(1, Math.round(n)));
    }

    function savePreferences() {
        const normal = parseStepInput($('#pref-seek-step').value, DEFAULT_SEEK_STEP);
        const fast = parseStepInput($('#pref-seek-step-shift').value, DEFAULT_SEEK_STEP_SHIFT);
        localStorage.setItem(SEEK_STEP_KEY, String(normal));
        localStorage.setItem(SEEK_STEP_SHIFT_KEY, String(fast));

        setAutoSaveEnabled(!!($('#pref-auto-save-enabled') && $('#pref-auto-save-enabled').checked));

        closePreferencesModal();
        UI.toast('Preferencias guardadas ✅', 'success');
    }

    function resetPreferences() {
        localStorage.setItem(SEEK_STEP_KEY, String(DEFAULT_SEEK_STEP));
        localStorage.setItem(SEEK_STEP_SHIFT_KEY, String(DEFAULT_SEEK_STEP_SHIFT));
        setAutoSaveEnabled(false);
        openPreferencesModal();
        UI.toast('Preferencias restablecidas', 'info');
    }

    async function runAutoSaveTick() {
        if (!isAutoSaveEnabled()) return;
        if (_autoSaveInFlight) return;
        if (!hasUnsavedChanges) return;
        if (!AppState.get('currentProjectId')) return;

        _autoSaveInFlight = true;
        try {
            await AppState.saveToCloud();
        } catch (e) {
            console.error('Auto-save failed:', e);
            UI.toast('No se pudo auto-guardar (conexión).', 'error');
        } finally {
            _autoSaveInFlight = false;
        }
    }

    function wireAutoSaveLoop() {
        if (_autoSaveTimer) return;
        _autoSaveTimer = setInterval(runAutoSaveTick, AUTO_SAVE_INTERVAL_MS);
    }

    function wirePreferencesModal() {
        const modal = $('#modal-preferences');
        if (!modal || modal.dataset.wired) return;
        modal.dataset.wired = '1';

        $('#btn-pref-cancel')?.addEventListener('click', closePreferencesModal);
        $('#btn-pref-save')?.addEventListener('click', savePreferences);
        $('#btn-pref-reset')?.addEventListener('click', resetPreferences);
        modal.querySelector('.modal-backdrop')?.addEventListener('click', closePreferencesModal);
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closePreferencesModal();
            }
        });

    }

    function guardFeature(feature, action) {
        if (AppState.hasFeature(feature)) {
            action();
            return true;
        }
        UI.toast(getProFeatureMessage(), 'info');
        return false;
    }

    function getProFeatureMessage() {
        return getCurrentUser()
            ? 'Esta función requiere el plan PRO'
            : 'Iniciá sesión para activar funciones PRO';
    }

    function isLocalDevHost() {
        const host = String(window.location.hostname || '').toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    }

    function getDevProFeatureFlags() {
        const flags = {};
        for (const feature of Object.values(FEATURES)) flags[feature] = true;
        return flags;
    }

    function resetLiveProbe() {
        _liveProbeLastDuration = 0;
        _liveProbeLastTs = 0;
        _liveDurationGrowthHits = 0;
        _liveDetectedSticky = false;
        _liveControlPinned = false;
    }

    function updateLiveEdgeButton() {
        const btn = $('#btn-live-edge');
        if (!btn) return;
        // Live-edge control temporarily disabled (will be reintroduced with deterministic config).
        btn.classList.add('hidden');
        return;

        const mode = AppState.get('mode');
        const game = AppState.getCurrentGame();
        const isYoutube = !!(game && game.youtube_video_id && !game.local_video_url);
        const inAnalyzeYoutube = mode === 'analyze' && isYoutube;
        const playerReady = YTPlayer.isReady();

        if (!inAnalyzeYoutube) {
            btn.classList.add('hidden');
            resetLiveProbe();
            return;
        }

        // If this session already detected live, keep the control visible even if
        // player readiness/duration fluctuates transiently near live edge.
        if (_liveControlPinned && !playerReady) {
            btn.classList.remove('hidden');
            btn.textContent = '🔴 En vivo';
            btn.classList.add('is-live');
            btn.disabled = true;
            btn.title = 'En vivo';
            return;
        }

        if (!playerReady) {
            btn.classList.add('hidden');
            return;
        }

        const now = Date.now();
        const duration = Number(YTPlayer.getDuration()) || 0;
        const current = Number(YTPlayer.getCurrentTime()) || 0;
        if (!duration || !Number.isFinite(duration)) {
            if (_liveControlPinned) {
                btn.classList.remove('hidden');
                btn.textContent = '🔴 En vivo';
                btn.classList.add('is-live');
                btn.disabled = true;
                btn.title = 'En vivo';
            } else {
                btn.classList.add('hidden');
            }
            return;
        }
        const liveFromPlayer = (typeof YTPlayer.isLiveStream === 'function') ? YTPlayer.isLiveStream() : null;

        if (_liveProbeLastTs > 0) {
            const dt = now - _liveProbeLastTs;
            const dd = duration - _liveProbeLastDuration;
            // Live streams typically increase reported duration over time.
            if (dt >= 900) {
                if (dd > 0.35 && dd < 3.0) _liveDurationGrowthHits = Math.min(6, _liveDurationGrowthHits + 1);
                else if (dd < 0.08) _liveDurationGrowthHits = Math.max(0, _liveDurationGrowthHits - 1);
            }
        }
        _liveProbeLastDuration = duration;
        _liveProbeLastTs = now;

        if (liveFromPlayer === true || _liveDurationGrowthHits >= 2) {
            _liveDetectedSticky = true;
            _liveControlPinned = true;
        }
        const isLikelyLive = _liveDetectedSticky || _liveControlPinned;
        if (!isLikelyLive) {
            btn.classList.add('hidden');
            return;
        }

        btn.classList.remove('hidden');
        const lag = Math.max(0, duration - current);
        if (lag <= LIVE_EDGE_THRESHOLD_SEC) {
            btn.textContent = '🔴 En vivo';
            btn.classList.add('is-live');
            btn.disabled = true;
            btn.title = 'Ya estás en vivo';
        } else {
            btn.textContent = '↩ Volver al vivo';
            btn.classList.remove('is-live');
            btn.disabled = false;
            btn.title = `Estás ${Math.round(lag)}s atrás`;
        }
    }

    function getGrantRemainingText(userDoc) {
        if (!userDoc || userDoc.accessType !== 'granted') return '';
        const expMs = toMillis(userDoc.grantExpiresAt);
        if (!expMs) return '';
        const farFuture = new Date('9999-12-31T23:59:59.999Z').getTime();
        if (expMs >= farFuture - 120000) return 'Acceso: sin vencimiento';
        const diff = expMs - Date.now();
        if (diff <= 0) return 'Acceso grant vencido';
        const days = Math.ceil(diff / 86400000);
        return `Acceso grant: ${days} ${days === 1 ? 'día' : 'días'} restantes`;
    }

    function updateAuthHeader(user) {
        const trigger = $('#auth-menu-trigger');
        const menu = $('#auth-menu');
        const nameEl = $('#auth-menu-name');
        const planEl = $('#auth-menu-plan');
        const helpEl = $('#auth-menu-help');
        const grantEl = $('#auth-menu-grant');
        const loginBtn = $('#auth-menu-login');
        const logoutBtn = $('#auth-menu-logout');
        if (!trigger || !menu) return;

        const isLogged = !!user;
        trigger.classList.toggle('is-authenticated', isLogged);
        const displayName = user ? (user.displayName || user.email || user.uid) : 'No logueado';
        if (nameEl) {
            nameEl.textContent = displayName;
            nameEl.title = displayName;
        }

        const plan = resolveEffectivePlan(latestUserDoc);
        if (planEl) {
            planEl.textContent = String(plan || 'free').toUpperCase();
        }
        if (helpEl) {
            helpEl.textContent = !isLogged
                ? 'Iniciá sesión para ver tus proyectos y activar funciones PRO.'
                : plan === 'pro'
                    ? 'Tu cuenta PRO tiene todas las funciones activas.'
                    : 'Actualizá a PRO para compartir, importar y usar video local.';
        }

        const grantText = getGrantRemainingText(latestUserDoc);
        if (grantEl) {
            grantEl.textContent = grantText;
            grantEl.style.display = grantText ? 'block' : 'none';
        }

        if (loginBtn) loginBtn.style.display = isLogged ? 'none' : 'inline-flex';
        if (logoutBtn) logoutBtn.style.display = isLogged ? 'inline-flex' : 'none';
        const accountBtn = $('#auth-menu-account');
        if (accountBtn) accountBtn.style.display = isLogged ? 'inline-flex' : 'none';
    }

    function wireAuthMenu() {
        if (authMenuWired) return;
        authMenuWired = true;
        const trigger = $('#auth-menu-trigger');
        const menu = $('#auth-menu');
        const loginBtn = $('#auth-menu-login');
        const logoutBtn = $('#auth-menu-logout');
        if (!trigger || !menu) return;

        const closeMenu = () => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        };
        const openMenu = () => {
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        };

        trigger.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (menu.hidden) {
                // Keep top-right menus mutually exclusive
                const headerNav = $('#header-nav-menu');
                const headerNavTrigger = $('#btn-header-nav');
                if (headerNav && !headerNav.hidden) {
                    headerNav.hidden = true;
                    headerNavTrigger?.setAttribute('aria-expanded', 'false');
                }
                openMenu();
            } else closeMenu();
        });

        document.addEventListener('click', (ev) => {
            if (!menu.hidden && !menu.contains(ev.target) && !trigger.contains(ev.target)) {
                closeMenu();
            }
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeMenu();
        });

        loginBtn?.addEventListener('click', async () => {
            try {
                await loginWithGoogle();
                UI.toast('Sesión iniciada', 'success');
                closeMenu();
            } catch (e) {
                console.error(e);
                UI.toast('No se pudo iniciar sesión', 'error');
            }
        });
        logoutBtn?.addEventListener('click', async () => {
            try {
                await SessionGuard.stop(true);
                await logout();
                closeMenu();
            } catch (e) {
                console.error(e);
            }
        });
    }

    function wireSessionConflictModal() {
        const btn = $('#btn-session-conflict-logout');
        if (!btn || btn.dataset.wiredConflictLogout) return;
        btn.dataset.wiredConflictLogout = '1';
        btn.addEventListener('click', async () => {
            try {
                await SessionGuard.stop(true);
            } catch (_) { /* noop */ }
            try {
                await logout();
            } catch (_) { /* noop */ }
            UI.hideModal('modal-session-conflict');
            _sessionConflictLocked = false;
        });
    }

    function _popoutGetSnapshot() {
        const media = YTPlayer.getLastMedia ? YTPlayer.getLastMedia() : null;
        let snapshotMedia = null;
        if (media) {
            if (media.kind === 'youtube' && media.id) {
                snapshotMedia = { kind: 'youtube', id: media.id };
            } else if (media.kind === 'local' && media.file) {
                snapshotMedia = { kind: 'local', file: media.file };
            }
        }
        return {
            media: snapshotMedia,
            currentTime: YTPlayer.getCurrentTime ? (YTPlayer.getCurrentTime() || 0) : 0,
            isPlaying: YTPlayer.isPlaying ? !!YTPlayer.isPlaying() : false,
            rate: 1,
            volume: YTPlayer.getVolume ? YTPlayer.getVolume() : 100,
            muted: YTPlayer.isMuted ? !!YTPlayer.isMuted() : false
        };
    }

    function wirePopout() {
        if (typeof YTPlayer.setCommandListener !== 'function') return;

        PopoutController.setProvider({ getSnapshot: _popoutGetSnapshot });
        PopoutController.setMirrorHandler((payload) => {
            // Policy: audio only in popup while it's active.
            if (payload && payload.action === 'volume') return;
            if (YTPlayer.mirrorRemotePlayback) YTPlayer.mirrorRemotePlayback(payload);
        });

        YTPlayer.setCommandListener((type, payload) => {
            if (!(PopoutController.isConnected && PopoutController.isConnected())) return;
            switch (type) {
                case 'mediaLoaded':
                    if (payload?.kind === 'liveCapture') break;
                    if (payload && payload.kind === 'youtube') {
                        PopoutController.notifyMediaLoaded({ kind: 'youtube', id: payload.id });
                    } else if (payload && payload.kind === 'local' && payload.file) {
                        PopoutController.notifyMediaLoaded({ kind: 'local', file: payload.file });
                    }
                    break;
                case 'play':
                    PopoutController.notifyPlay();
                    break;
                case 'pause':
                    PopoutController.notifyPause();
                    break;
                case 'seek':
                    if (payload && typeof payload.seconds === 'number') {
                        PopoutController.notifySeek(payload.seconds);
                    }
                    break;
                case 'speed':
                    if (payload && typeof payload.rate === 'number') {
                        PopoutController.notifySpeed(payload.rate);
                    }
                    break;
                case 'volume':
                    if (payload && (typeof payload.volume === 'number' || typeof payload.muted === 'boolean')) {
                        PopoutController.notifyVolume(payload);
                    }
                    break;
                default:
                    break;
            }
        });

        const pill = $('#popout-status-pill');
        const closeBtn = $('#btn-popout-close');
        if (pill) pill.hidden = true;
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                PopoutController.close();
            });
        }
        PopoutController.onActiveChange((active) => {
            if (pill) pill.hidden = !active;
            if (active) {
                if (_mainAudioBeforePopout === null) {
                    _mainAudioBeforePopout = {
                        muted: YTPlayer.isMuted ? !!YTPlayer.isMuted() : false,
                        volume: YTPlayer.getVolume ? YTPlayer.getVolume() : 100
                    };
                }
                if (YTPlayer.mute) YTPlayer.mute();
            } else if (_mainAudioBeforePopout) {
                if (typeof _mainAudioBeforePopout.volume === 'number' && YTPlayer.setVolume) {
                    YTPlayer.setVolume(_mainAudioBeforePopout.volume);
                }
                if (_mainAudioBeforePopout.muted) {
                    if (YTPlayer.mute) YTPlayer.mute();
                } else if (YTPlayer.unMute) {
                    YTPlayer.unMute();
                }
                _mainAudioBeforePopout = null;
            }
        });

        const openBtn = $('#btn-open-popout');
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (!AppState.hasFeature(FEATURES.POPOUT_PLAYER)) {
                    UI.toast(getProFeatureMessage(), 'info');
                    return;
                }
                const game = AppState.getCurrentGame();
                if (!game) {
                    UI.toast('Abrí o creá un proyecto primero', 'info');
                    return;
                }
                const ok = PopoutController.open();
                if (!ok) {
                    UI.toast('No se pudo abrir la ventana. Permití popups para este sitio.', 'error');
                    return;
                }
                UI.toast('Player externo abierto', 'success');
            });
        }
    }

    async function consolidateStoppedCaptureToProject() {
        const meta = getLastStoppedSession();
        if (!meta) {
            UI.toast('No hay grabación para consolidar.', 'error');
            return;
        }
        try {
            const out = await promoteStoppedSessionToLocal(YTPlayer, meta, { download: true });
            if (out?.file && out.objectUrl) {
                _localVideoFileForCurrentGame = out.file;
                AppState.setLocalVideoFile(out.file);
                const game = AppState.getCurrentGame();
                if (game) {
                    game.local_video_url = out.objectUrl;
                    // Deja de ser «proyecto solo captura»: al guardar no se persiste el blob; si sigue
                    // video_source=liveCapture, al reabrir se carga una sesión vacía y el play no va al archivo.
                    if (game.video_source === 'liveCapture') {
                        delete game.video_source;
                    }
                }
                UI.toast('Video listo: descarga iniciada y cargado en el partido.', 'success');
                UI.refreshAll();
                syncAnalyzeLiveCaptureTabVisibility();
            }
        } catch (e) {
            UI.toast(e?.message || 'No se pudo consolidar', 'error');
        }
    }

    function syncPlayerChromeUi() {
        const chrome = $('#player-chrome');
        if (!chrome || chrome.classList.contains('hidden')) return;
        if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady()) return;

        const playGroup = $('#player-chrome-play-group');
        playGroup?.classList.remove('hidden');
        const playBtn = $('#player-chrome-play');
        if (playBtn) {
            const playing = YTPlayer.isPlaying();
            playBtn.innerHTML = playing
                ? '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h4v12H7zM13 6h4v12h-4z" fill="currentColor"/></svg>'
                : '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12l10-6z" fill="currentColor"/></svg>';
            playBtn.setAttribute('aria-label', playing ? 'Pausa' : 'Reproducir');
        }

        const muteBtn = $('#player-chrome-mute');
        if (muteBtn && YTPlayer.isMuted) {
            const m = YTPlayer.isMuted();
            muteBtn.setAttribute('aria-pressed', m ? 'true' : 'false');
            const popoutConnected = PopoutController && PopoutController.isConnected && PopoutController.isConnected();
            muteBtn.disabled = !!popoutConnected;
            muteBtn.title = popoutConnected ? 'Audio solo en player externo' : 'Silenciar o activar sonido';
            muteBtn.innerHTML = m
                ? '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3Zm10.8 2 2.9 2.9 1.4-1.4-2.9-2.9 2.9-2.9-1.4-1.4-2.9 2.9-2.9-2.9-1.4 1.4 2.9 2.9-2.9 2.9 1.4 1.4 2.9-2.9Z" fill="currentColor"/></svg>'
                : '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3Zm12.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 15.5 12Z" fill="currentColor"/></svg>';
        }

        const canNavigateClips = AppState.get('mode') === 'view';
        const btnBack = $('#player-chrome-seek-back');
        const btnFwd = $('#player-chrome-seek-fwd');
        if (btnBack) {
            btnBack.disabled = !canNavigateClips;
            btnBack.setAttribute('aria-disabled', (!canNavigateClips).toString());
            btnBack.title = canNavigateClips ? 'Clip anterior' : 'Disponible en modo Ver';
        }
        if (btnFwd) {
            btnFwd.disabled = !canNavigateClips;
            btnFwd.setAttribute('aria-disabled', (!canNavigateClips).toString());
            btnFwd.title = canNavigateClips ? 'Siguiente clip' : 'Disponible en modo Ver';
        }

        const fullscreenBtn = $('#player-chrome-fullscreen');
        if (fullscreenBtn) {
            const container = $('#player-container');
            const mode = AppState.get('mode');
            const isViewMode = mode === 'view';
            fullscreenBtn.style.display = isViewMode ? '' : 'none';
            if (container) {
                const isFullscreen = document.fullscreenElement === container;
                fullscreenBtn.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
                fullscreenBtn.setAttribute('aria-label', isFullscreen ? 'Salir de pantalla completa' : 'Entrar en pantalla completa');
                fullscreenBtn.title = isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa';
                fullscreenBtn.innerHTML = isFullscreen
                    ? '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5h2V5h3V3Zm13 0h-5v2h3v3h2V3ZM5 16H3v5h5v-2H5v-3Zm16 0h-2v3h-3v2h5v-5Z" fill="currentColor"/></svg>'
                    : '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H3v4h2V5h2V3Zm14 0h-4v2h2v2h2V3ZM5 17H3v4h4v-2H5v-2Zm16 0h-2v2h-2v2h4v-4Z" fill="currentColor"/></svg>';
            }
        }
    }

    function showPlayerSeekFeedback(dir, seconds, sideHint = null) {
        const container = $('#player-container');
        if (!container) return;
        let badge = container.querySelector('.player-surface-seek-feedback');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'player-surface-seek-feedback';
            container.appendChild(badge);
        }
        const effectiveDir = dir < 0 ? -1 : 1;
        const side = sideHint || (effectiveDir > 0 ? 'right' : 'left');
        badge.textContent = `${effectiveDir > 0 ? '+' : '-'}${Math.max(1, Math.round(Number(seconds) || 0))}`;
        badge.classList.remove('left', 'right', 'show');
        badge.classList.add(side === 'left' ? 'left' : 'right');
        void badge.offsetWidth; // restart animation
        badge.classList.add('show');
    }

    function navigateToClipAndPlay(direction) {
        if (AppState.get('activeCollection')) {
            AppState.navigateCollectionItem(direction);
            return;
        }
        AppState.navigateClip(direction);
        const clip = AppState.getCurrentClip();
        if (!clip) return;
        YTPlayer.playClip(clip.start_sec, clip.end_sec);
        const plId = AppState.get('activePlaylistId');
        if (plId && typeof DrawingTool !== 'undefined') DrawingTool.startPlaybackWatch(plId, clip.id);
    }

    /**
     * Pestaña «Captura en vivo» en el panel Analizar (LiveCapture).
     * @param {import('./livecapture/LiveCaptureFacade.js').LiveCaptureFacade|null} facade
     */
    function wireLiveCaptureAnalyzeTab(facade) {
        const $ = UI.$;
        const tabClips = $('#tab-analyze-clips');
        const tabLc = $('#tab-analyze-livecapture');
        const paneClips = $('#analyze-tab-clips');
        const paneLc = $('#analyze-tab-livecapture');
        const unavailableEl = $('#livecapture-unavailable');
        const controlsEl = $('#livecapture-controls');
        const statusEl = $('#livecapture-status');
        const selRes = $('#livecapture-resolution');
        const selDevice = $('#livecapture-device');
        const btnSetupDevices = $('#btn-livecapture-setup-devices');
        const btnRec = $('#btn-livecapture-rec');
        const btnPause = $('#btn-livecapture-pause');
        const btnStop = $('#btn-livecapture-stop');
        const btnBackLive = $('#btn-livecapture-back-live');
        const btnDownload = $('#btn-livecapture-download');

        if (!paneLc || !facade) return;

        function downloadLocalCaptureFile(file) {
            if (!file || typeof document === 'undefined') return;
            const url = URL.createObjectURL(file);
            try {
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name || 'captura.webm';
                a.rel = 'noopener';
                a.click();
            } catch (_) {
                /* noop */
            }
            setTimeout(() => {
                try {
                    URL.revokeObjectURL(url);
                } catch (_) {
                    /* noop */
                }
            }, 2500);
        }

        const envOk = typeof canRunLiveCapture === 'function' && canRunLiveCapture();
        if (!envOk && unavailableEl && controlsEl) {
            unavailableEl.textContent =
                'La captura desde cámara no está disponible aquí (probá HTTPS en localhost o Chrome actualizado).';
            unavailableEl.classList.remove('hidden');
            controlsEl.classList.add('hidden');
        }

        function ensureCaptureSessionId() {
            if (facade.getSessionId?.()) return;
            const gid = AppState.get('currentGameId');
            if (!gid) return;
            const sid = `lc-${gid}-${Date.now()}`;
            YTPlayer.loadLiveCapture?.({ sessionId: sid });
        }

        let _previewDebounce = null;
        function scheduleLivePreviewRefresh() {
            clearTimeout(_previewDebounce);
            _previewDebounce = setTimeout(() => {
                refreshLivePreviewNow();
            }, 200);
        }

        async function refreshLivePreviewNow() {
            if (!envOk || isLiveRecordingActive()) return;
            const game = AppState.getCurrentGame?.();
            if (game?.video_source !== 'liveCapture') return;
            try {
                ensureCaptureSessionId();
                if (!facade.getSessionId?.()) return;
                const deviceId = ($('#livecapture-device')?.value || '').trim() || undefined;
                const resolution = selRes?.value === '1080' ? '1080' : '720';
                await startLivePreview({ facade, deviceId, resolution });
            } catch (e) {
                console.warn('[LiveCapture] vista previa:', e?.message || e);
            }
            refreshLiveCapturePanelState();
        }

        function switchAnalyzeTab(which) {
            const isClips = which === 'clips';
            if (tabClips) {
                tabClips.classList.toggle('active', isClips);
                tabClips.setAttribute('aria-selected', isClips ? 'true' : 'false');
            }
            if (tabLc) {
                tabLc.classList.toggle('active', !isClips);
                tabLc.setAttribute('aria-selected', !isClips ? 'true' : 'false');
            }
            if (paneClips) paneClips.classList.toggle('hidden', !isClips);
            if (paneLc) paneLc.classList.toggle('hidden', isClips);
            if (!isClips) {
                refreshLiveCapturePanelState();
                scheduleLivePreviewRefresh();
            }
        }

        _switchAnalyzeTabRef = switchAnalyzeTab;

        document.querySelectorAll('[data-analyze-tab]').forEach((btn) => {
            btn.addEventListener('click', () => switchAnalyzeTab(btn.getAttribute('data-analyze-tab')));
        });

        function syncLiveCaptureToolbar() {
            const recording = isLiveRecordingActive();
            const previewActive =
                typeof isLivePreviewActive === 'function' && isLivePreviewActive();
            const previewOnly = !recording && previewActive;
            const mode = facade.getMode?.() ?? 'live';
            const inReview = recording && mode === 'review';
            const gidTb = AppState.get('currentGameId');
            const gameTb = gidTb ? AppState.getCurrentGame?.() : null;
            const isCaptureProjectTb = gameTb?.video_source === 'liveCapture';
            const block = !envOk || !facade || !isCaptureProjectTb;

            if (btnRec) {
                btnRec.disabled = block || !previewOnly;
                const recOn = recording && !block;
                const recPaused = recOn && isLiveRecordingPaused();
                btnRec.classList.toggle('livecapture-rec--recording', recOn && !recPaused);
                btnRec.classList.toggle('livecapture-rec--recording-paused', recOn && recPaused);
            }
            if (btnPause && btnStop) {
                btnPause.disabled = block || !recording;
                btnStop.disabled = block || !recording;
                btnPause.classList.toggle('player-chrome__btn--primary', !!recording);
                const paused = recording && isLiveRecordingPaused();
                btnPause.innerHTML = paused
                    ? '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12l10-6z" fill="currentColor"/></svg>'
                    : '<svg class="player-chrome__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h4v12H7zM13 6h4v12h-4z" fill="currentColor"/></svg>';
                btnPause.setAttribute('aria-label', paused ? 'Reanudar grabación' : 'Pausar grabación');
                btnPause.title = paused ? 'Reanudar grabación' : 'Pausar grabación';
            }
            if (btnBackLive) {
                btnBackLive.disabled = block || !inReview;
                btnBackLive.classList.toggle('livecapture-live-return--away', !!(!block && inReview));
                btnBackLive.title =
                    inReview && !block ? 'Volver al vivo' : 'Disponible cuando estés revisando el replay';
            }
        }

        function refreshLiveCapturePanelState() {
            const recording = isLiveRecordingActive();
            const mode = facade.getMode?.() ?? 'live';
            const gid = AppState.get('currentGameId');
            const game = gid ? AppState.getCurrentGame?.() : null;
            const isCaptureProject = game?.video_source === 'liveCapture';

            if (selRes) selRes.disabled = !!recording;
            if (selDevice) selDevice.disabled = !!recording;
            if (btnSetupDevices) btnSetupDevices.disabled = !!recording || !envOk;

            if (btnDownload) {
                btnDownload.disabled = !AppState.getLocalVideoFile?.();
            }

            syncLiveCaptureToolbar();

            const lines = [];
            if (!envOk) {
                lines.push('Captura no disponible aquí.');
            } else if (!isCaptureProject) {
                lines.push('No es proyecto de captura.');
            } else if (recording) {
                lines.push(mode === 'review' ? 'Grabando · revisión' : 'Grabando');
            }
            if (statusEl) statusEl.innerHTML = lines.length ? lines.join('<br/>') : '';
        }

        btnSetupDevices?.addEventListener('click', async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                stream.getTracks().forEach((t) => t.stop());
                const devices = await listVideoInputs();
                const sel = $('#livecapture-device');
                const prev = sel?.value || '';
                if (sel) {
                    sel.innerHTML = '<option value="">Predeterminada del sistema</option>';
                    devices.forEach((d) => {
                        const opt = document.createElement('option');
                        opt.value = d.deviceId;
                        opt.textContent = d.label || 'Cámara';
                        sel.appendChild(opt);
                    });
                    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
                }
                UI.toast('Cámaras detectadas', 'success');
                scheduleLivePreviewRefresh();
            } catch (e) {
                UI.toast(e?.message || 'No se pudo acceder a la cámara', 'error');
            }
        });

        selDevice?.addEventListener('change', () => scheduleLivePreviewRefresh());
        selRes?.addEventListener('change', () => scheduleLivePreviewRefresh());

        btnRec?.addEventListener('click', async () => {
            if (typeof isLiveRecordingActive === 'function' && isLiveRecordingActive()) return;
            if (typeof isLivePreviewActive !== 'function' || !isLivePreviewActive()) {
                UI.toast('Elegí cámara y resolución arriba.', 'info');
                return;
            }
            if (!facade) return;
            const sid = facade.getSessionId?.();
            if (!sid) {
                UI.toast('Sesión de captura no lista.', 'error');
                return;
            }
            const deviceId = ($('#livecapture-device')?.value || '').trim() || undefined;
            const resolution = $('#livecapture-resolution')?.value === '1080' ? '1080' : '720';
            try {
                await startLiveRecording({
                    facade,
                    sessionId: sid,
                    deviceId,
                    resolution,
                });
                UI.toast('Grabando', 'success');
            } catch (e) {
                UI.toast(e?.message || 'No se pudo iniciar la grabación', 'error');
            }
            refreshLiveCapturePanelState();
        });

        btnPause?.addEventListener('click', () => {
            if (!isLiveRecordingActive()) return;
            if (isLiveRecordingPaused()) resumeLiveRecording();
            else pauseLiveRecording();
            refreshLiveCapturePanelState();
            queueMicrotask(() => refreshLiveCapturePanelState());
        });

        btnStop?.addEventListener('click', async () => {
            if (!isLiveRecordingActive()) return;
            const ok = window.confirm(
                '¿Finalizar la grabación y consolidar el video?\n\nSe descargará una copia .webm y quedará cargada en este partido.'
            );
            if (!ok) return;
            try {
                await stopLiveRecording();
                await consolidateStoppedCaptureToProject();
            } catch (e) {
                UI.toast(e?.message || 'Error al finalizar la grabación', 'error');
            }
            refreshLiveCapturePanelState();
        });

        btnBackLive?.addEventListener('click', () => {
            facade.goLive?.();
            refreshLiveCapturePanelState();
        });

        btnDownload?.addEventListener('click', () => {
            const f = AppState.getLocalVideoFile?.();
            if (!f) {
                UI.toast('No hay video local para descargar (detené la grabación antes).', 'info');
                return;
            }
            downloadLocalCaptureFile(f);
            UI.toast('Descarga iniciada', 'success');
        });

        setInterval(refreshLiveCapturePanelState, 1000);
        refreshLiveCapturePanelState();
    }

    function wirePlayerChrome() {
        const root = $('#player-chrome');
        if (!root || root.dataset.wired === '1') return;
        root.dataset.wired = '1';
        const swallow = (ev) => ev.stopPropagation();
        root.addEventListener('click', swallow);
        root.addEventListener('dblclick', swallow);
        root.addEventListener('touchend', swallow, { passive: true });

        const clipToolbar = $('#clip-view-toolbar');
        if (clipToolbar && clipToolbar.dataset.surfaceGuardWired !== '1') {
            clipToolbar.dataset.surfaceGuardWired = '1';
            clipToolbar.addEventListener('click', swallow);
            clipToolbar.addEventListener('dblclick', swallow);
            clipToolbar.addEventListener('touchend', swallow, { passive: true });
        }

        const navigateClipFromChrome = (dir) => {
            if (AppState.get('mode') !== 'view') return;
            if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady()) return;
            navigateToClipAndPlay(dir < 0 ? 'prev' : 'next');
        };

        $('#player-chrome-seek-back')?.addEventListener('click', () => navigateClipFromChrome(-1));
        $('#player-chrome-seek-fwd')?.addEventListener('click', () => navigateClipFromChrome(1));

        $('#player-chrome-play')?.addEventListener('click', () => {
            if (typeof DrawingTool !== 'undefined' && DrawingTool.hasPlaybackOverlays()) {
                DrawingTool.dismissPlaybackOverlays();
                YTPlayer.play();
            } else {
                YTPlayer.togglePlay();
            }
            syncPlayerChromeUi();
        });

        $('#player-chrome-mute')?.addEventListener('click', () => {
            if (PopoutController && PopoutController.isConnected && PopoutController.isConnected()) return;
            if (YTPlayer.toggleMute) YTPlayer.toggleMute();
            syncPlayerChromeUi();
        });

        $('#player-chrome-fullscreen')?.addEventListener('click', async () => {
            const container = $('#player-container');
            if (!container) return;
            try {
                if (document.fullscreenElement === container) {
                    await document.exitFullscreen();
                } else if (!document.fullscreenElement) {
                    await container.requestFullscreen();
                } else {
                    await document.exitFullscreen();
                    await container.requestFullscreen();
                }
            } catch (_) {
                UI.toast('No se pudo activar pantalla completa', 'error');
            }
            syncPlayerChromeUi();
        });

        document.addEventListener('fullscreenchange', syncPlayerChromeUi);

        setInterval(syncPlayerChromeUi, 450);
    }

    function wirePlayerSurfaceToggle() {
        const container = $('#player-container');
        if (!container || container.dataset.surfaceToggleWired === '1') return;
        container.dataset.surfaceToggleWired = '1';
        let singleClickTimer = null;
        let suppressSingleClickUntil = 0;
        let lastTapTs = 0;
        let lastTapX = 0;
        const DOUBLE_TAP_MS = 320;
        const DOUBLE_TAP_MAX_DELTA_X = 140;

        const canHandleSurfaceGesture = (evTarget) => {
            if (!AppState.get('currentGameId')) return false;
            if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady() || !YTPlayer.seekTo) return false;
            if (typeof YTPlayer.getSourceType === 'function' && YTPlayer.getSourceType() === 'local') return false;
            if (!evTarget) return false;
            if (evTarget.closest('#player-chrome')) return false;
            if (evTarget.closest('#clip-view-toolbar')) return false;
            if (evTarget.closest('#drawing-toolbar')) return false;
            if (evTarget.closest('video')) return false;
            if (evTarget.closest('button, a, input, textarea, select, [role="button"]')) return false;
            if (typeof DrawingTool !== 'undefined' && typeof DrawingTool.isActive === 'function' && DrawingTool.isActive()) return false;
            return true;
        };

        const seekBySurface = (dir) => {
            const t = YTPlayer.getCurrentTime() || 0;
            const step = getSeekStep(false);
            const next = dir < 0 ? Math.max(0, t - step) : t + step;
            YTPlayer.seekTo(next);
            showPlayerSeekFeedback(dir, step, dir < 0 ? 'left' : 'right');
        };

        const resolveDirectionFromX = (clientX) => {
            const rect = container.getBoundingClientRect();
            const midX = rect.left + (rect.width / 2);
            return clientX < midX ? -1 : 1;
        };

        container.addEventListener('click', (ev) => {
            if (Date.now() < suppressSingleClickUntil) return;
            // Only primary-button clicks; ignore modified clicks.
            if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
            if (!canHandleSurfaceGesture(ev.target)) return;
            if (typeof YTPlayer === 'undefined' || !YTPlayer.togglePlay) return;
            if (singleClickTimer) clearTimeout(singleClickTimer);
            singleClickTimer = setTimeout(() => {
                YTPlayer.togglePlay();
                syncPlayerChromeUi();
                singleClickTimer = null;
            }, 260);
        });

        container.addEventListener('dblclick', (ev) => {
            if (ev.button !== 0) return;
            if (!canHandleSurfaceGesture(ev.target)) return;
            ev.preventDefault();
            if (singleClickTimer) {
                clearTimeout(singleClickTimer);
                singleClickTimer = null;
            }
            suppressSingleClickUntil = Date.now() + 350;
            seekBySurface(resolveDirectionFromX(ev.clientX));
        });

        container.addEventListener('touchend', (ev) => {
            if (!canHandleSurfaceGesture(ev.target)) return;
            const touch = ev.changedTouches && ev.changedTouches[0];
            if (!touch) return;
            const now = Date.now();
            const dt = now - lastTapTs;
            const dx = Math.abs(touch.clientX - lastTapX);
            if (dt > 0 && dt <= DOUBLE_TAP_MS && dx <= DOUBLE_TAP_MAX_DELTA_X) {
                if (singleClickTimer) {
                    clearTimeout(singleClickTimer);
                    singleClickTimer = null;
                }
                suppressSingleClickUntil = Date.now() + 350;
                seekBySurface(resolveDirectionFromX(touch.clientX));
                lastTapTs = 0;
                lastTapX = 0;
                return;
            }
            lastTapTs = now;
            lastTapX = touch.clientX;
        });
    }

    function wireHeaderNavMenu() {
        const trigger = $('#btn-header-nav');
        const menu = $('#header-nav-menu');
        if (!trigger || !menu || trigger.dataset.bbWired) return;
        trigger.dataset.bbWired = '1';
        const prefBtn = $('#btn-open-preferences');
        const autoSaveBtn = $('#btn-toggle-autosave');

        const closeMenu = () => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        };
        const openMenu = () => {
            syncAutoSaveMenuState();
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        };

        trigger.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (menu.hidden) {
                // Keep top-right menus mutually exclusive
                const authMenu = $('#auth-menu');
                const authTrigger = $('#auth-menu-trigger');
                if (authMenu && !authMenu.hidden) {
                    authMenu.hidden = true;
                    authTrigger?.setAttribute('aria-expanded', 'false');
                }
                openMenu();
            } else closeMenu();
        });

        menu.addEventListener('click', (ev) => {
            const localAutoSaveBtn = ev.target.closest('#btn-toggle-autosave');
            if (localAutoSaveBtn) {
                ev.preventDefault();
                ev.stopPropagation();
                const enabled = !isAutoSaveEnabled();
                setAutoSaveEnabled(enabled);
                UI.toast(enabled ? 'Auto-guardado activado (60s) ✅' : 'Auto-guardado desactivado', enabled ? 'success' : 'info');
                closeMenu();
                return;
            }
            const localPrefBtn = ev.target.closest('#btn-open-preferences');
            if (localPrefBtn) {
                ev.preventDefault();
                ev.stopPropagation();
                openPreferencesModal();
            }
            closeMenu();
        });

        if (prefBtn) {
            const onPref = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                openPreferencesModal();
                closeMenu();
            };
            prefBtn.addEventListener('pointerdown', onPref);
            prefBtn.addEventListener('click', onPref);
        }

        if (autoSaveBtn) {
            autoSaveBtn.addEventListener('pointerdown', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                autoSaveBtn.click();
            });
        }

        document.addEventListener('click', (ev) => {
            if (!menu.hidden && !menu.contains(ev.target) && !trigger.contains(ev.target)) {
                closeMenu();
            }
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeMenu();
        });
    }

    function wireMobileModeMenu() {
        const trigger = $('#btn-mobile-mode');
        const menu = $('#mobile-mode-menu');
        if (!trigger || !menu) return;

        const closeMenu = () => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        };
        const openMenu = () => {
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        };

        trigger.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (menu.hidden) openMenu();
            else closeMenu();
        });

        const applyModeFromEvent = (ev) => {
            const btn = ev.target.closest('.mobile-mode-item');
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            const mode = btn.dataset.mode;
            const urlParams = new URLSearchParams(window.location.search);
            const isReadOnly = urlParams.get('mode') === 'view';
            if (isReadOnly && mode !== 'view') {
                UI.toast('Este enlace está en solo lectura', 'info');
                closeMenu();
                return;
            }
            if (mode === 'share' && !AppState.hasFeature(FEATURES.SHARE)) {
                UI.toast(getProFeatureMessage(), 'info');
                closeMenu();
                return;
            }
            if (mode) AppState.setMode(mode);
            closeMenu();
        };
        menu.addEventListener('click', applyModeFromEvent);
        menu.addEventListener('pointerdown', applyModeFromEvent);

        document.addEventListener('click', (ev) => {
            if (!menu.hidden && !menu.contains(ev.target) && !trigger.contains(ev.target)) {
                closeMenu();
            }
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeMenu();
        });
    }

    onAuthChange(async (user) => {
        AppState.setAuthenticatedUser(user);
        wireAuthMenu();
        wireSessionConflictModal();
        wireHeaderNavMenu();
        wirePreferencesModal();
        wireQuickClipMenu();
        wireMobileModeMenu();
        if (user?.uid) {
            try {
                await SessionGuard.start(user.uid);
            } catch (e) {
                console.warn('Session guard start failed:', e);
            }
        } else {
            try {
                await SessionGuard.stop(false);
            } catch (_) { /* noop */ }
            UI.hideModal('modal-session-conflict');
            _sessionConflictLocked = false;
        }
        latestUserDoc = user ? await getUserDoc(user.uid) : null;
        updateAuthHeader(user);
        AppState.setFeatureFlags(isLocalDevHost()
            ? getDevProFeatureFlags()
            : resolveFeaturesForUser(latestUserDoc));
        syncReadOnlyCapabilitiesClass();
        syncHeaderProFeatureStates();
        UI.updateMode();
        syncNewProjectModalByPlan();
    });

    async function rememberLastProject(projectId) {
        const user = getCurrentUser();
        if (!user?.uid || !projectId) return;
        try {
            await setLastProjectForUser(user.uid, projectId);
        } catch (e) {
            console.warn('No se pudo guardar lastProjectId:', e);
        }
    }

    function syncReadOnlyCapabilitiesClass() {
        const canUseProNav = AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES);
        document.body.classList.toggle('read-only-pro', !!canUseProNav);
    }

    /**
     * Tras `clearProject` + borrador local nuevo: quita solo lectura / playlist-only de la shell,
     * limpia query params del enlace compartido y vuelve a modo Analizar.
     */
    function resetShellForNewLocalDraft() {
        document.body.classList.remove('read-only-mode', 'read-only-pro', 'playlist-only-mode');
        if (AppState.get('activeCollection')) {
            AppState.closeCollection();
        }
        const u = new URL(window.location.href);
        u.searchParams.delete('mode');
        u.searchParams.delete('playlist');
        u.searchParams.delete('project');
        u.searchParams.delete('game');
        u.searchParams.delete('editKey');
        u.searchParams.delete('collection');
        const qs = u.searchParams.toString();
        history.replaceState({}, '', u.pathname + (qs ? `?${qs}` : '') + u.hash);
        AppState.setMode('analyze');
        syncReadOnlyCapabilitiesClass();
        UI.updateMode();
    }

    function syncHeaderProFeatureStates() {
        const btnBB = $('#btn-open-buttonboards');
        if (btnBB) {
            btnBB.style.display = '';
            btnBB.classList.toggle('is-pro-locked', !AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES));
            btnBB.title = AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES)
                ? 'Ventanas de código'
                : 'Ventanas de código — PRO';
        }

        const btnPopout = $('#btn-open-popout');
        if (btnPopout) {
            btnPopout.classList.toggle('is-pro-locked', !AppState.hasFeature(FEATURES.POPOUT_PLAYER));
            btnPopout.title = AppState.hasFeature(FEATURES.POPOUT_PLAYER)
                ? 'Abrir player en ventana externa'
                : 'Player externo — PRO';
        }
    }

    // Extract YouTube video ID from any input (full URL or raw ID)
    function extractYouTubeId(input) {
        if (!input) return '';
        input = input.trim();
        // Full URL patterns
        const patterns = [
            /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
            /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
            /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
            /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
            /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        ];
        for (const pat of patterns) {
            const match = input.match(pat);
            if (match) return match[1];
        }
        // If it looks like a raw ID (11 chars, alphanumeric + _ -)
        if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
        // Return as-is as fallback
        return input;
    }

    // ═══════════════════════════════════════
    // STATE → UI BINDINGS
    // ═══════════════════════════════════════

    let hasUnsavedChanges = false;
    let _saveButtonResetTimer = null;

    function setSaveButtonState(state = hasUnsavedChanges ? 'dirty' : 'idle') {
        const btn = $('#btn-save-project');
        if (!btn) return;
        btn.classList.remove('is-dirty', 'is-saving', 'is-saved');
        btn.disabled = state === 'saving';

        if (_saveButtonResetTimer) {
            clearTimeout(_saveButtonResetTimer);
            _saveButtonResetTimer = null;
        }

        if (state === 'saving') {
            btn.textContent = '…';
            btn.title = 'Guardando proyecto';
            btn.setAttribute('aria-label', 'Guardando proyecto');
            btn.classList.add('is-saving');
            return;
        }

        if (state === 'saved') {
            btn.textContent = '✓';
            btn.title = 'Proyecto guardado';
            btn.setAttribute('aria-label', 'Proyecto guardado');
            btn.classList.add('is-saved');
            _saveButtonResetTimer = setTimeout(() => setSaveButtonState(), 1400);
            return;
        }

        btn.textContent = '💾';
        btn.title = hasUnsavedChanges ? 'Guardar cambios pendientes' : 'Guardar proyecto';
        btn.setAttribute('aria-label', btn.title);
        btn.classList.toggle('is-dirty', !!hasUnsavedChanges);
    }

    // Reset unsaved changes on load/save
    AppState.on('projectLoaded', () => {
        hasUnsavedChanges = false;
        setSaveButtonState();
    });
    AppState.on('projectSaved', () => {
        hasUnsavedChanges = false;
        setSaveButtonState('saved');
    });

    // Mark as unsaved when anything editable changes
    const markUnsaved = () => {
        hasUnsavedChanges = true;
        setSaveButtonState();
    };
    AppState.on('clipChanged', markUnsaved);
    AppState.on('clipsUpdated', markUnsaved);
    AppState.on('playlistsUpdated', markUnsaved);
    AppState.on('flagsUpdated', markUnsaved);
    AppState.on('clipCommentsUpdated', markUnsaved);
    AppState.on('tagTypesUpdated', markUnsaved);

    AppState.on('commentAdded', () => {
        markUnsaved();
    });

    AppState.on('activityLogUpdated', () => {
        markUnsaved();
    });

    // Re-render notifications after save (picks up new currentProjectId)
    AppState.on('projectSaved', () => {
        UI.renderNotifications();
    });

    window.addEventListener('beforeunload', (e) => {
        if (hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    setSaveButtonState();

    // Logo / Home link with confirmation
    const logoHome = $('#logo-home');
    if (logoHome) {
        logoHome.addEventListener('click', () => {
            const msg = '¿Estás seguro de que quieres salir del proyecto actual? Se perderán los cambios no guardados.';
            if (confirm(msg)) {
                window.location.href = 'index.html';
            }
        });
    }

    AppState.on('modeChanged', (mode) => {
        if (mode === 'analyze' && AppState.get('currentClipId')) {
            AppState.setCurrentClip(null);
        }
        UI.updateMode();
        updateLiveEdgeButton();
        syncLiveCaptureAnalyzeDock();
    });

    AppState.on('featuresChanged', () => {
        syncHeaderProFeatureStates();
        syncNewProjectModalByPlan();
        UI.updateMode();
    });

    const btnLiveEdge = $('#btn-live-edge');
    if (btnLiveEdge) {
        btnLiveEdge.addEventListener('click', () => {
            if (btnLiveEdge.disabled) return;
            if (typeof YTPlayer.jumpToLiveEdge === 'function') {
                YTPlayer.jumpToLiveEdge();
            }
            setTimeout(updateLiveEdgeButton, 250);
        });
    }

    function syncAnalyzeSubtabsToClips() {
        const tabClips = $('#tab-analyze-clips');
        const tabLc = $('#tab-analyze-livecapture');
        const paneClips = $('#analyze-tab-clips');
        const paneLc = $('#analyze-tab-livecapture');
        if (tabClips) {
            tabClips.classList.add('active');
            tabClips.setAttribute('aria-selected', 'true');
        }
        if (tabLc) {
            tabLc.classList.remove('active');
            tabLc.setAttribute('aria-selected', 'false');
        }
        if (paneClips) paneClips.classList.remove('hidden');
        if (paneLc) paneLc.classList.add('hidden');
    }

    /** Solo partidos creados como captura en vivo (`video_source === 'liveCapture'`). */
    function syncAnalyzeLiveCaptureTabVisibility() {
        const game = AppState.getCurrentGame?.();
        const showLc = !!(game && game.video_source === 'liveCapture');
        const panelAnalyze = $('#panel-analyze');
        panelAnalyze?.classList.toggle('panel-analyze--livecapture', !!showLc);
        const tabLcBtn = $('#tab-analyze-livecapture');
        if (tabLcBtn) {
            tabLcBtn.classList.toggle('hidden', !showLc);
            if (!showLc) {
                syncAnalyzeSubtabsToClips();
            }
        }
        syncLiveCaptureAnalyzeDock();
    }

    /** Bloque «Exportar» en pestaña Captura en vivo (debajo de la configuración); mismo criterio que el dock. */
    function syncLiveCaptureExportStrip() {
        const strip = $('#livecapture-export-strip');
        const game = AppState.getCurrentGame?.();
        const mode = AppState.get('mode');
        const isCapture = !!(game && game.video_source === 'liveCapture');
        const show = isCapture && mode === 'analyze';
        strip?.classList.toggle('hidden', !show);
    }

    /** Dock de captura (estado + botonera) visible en Analizar para proyectos liveCapture; oculta playlists en Clips. */
    function syncLiveCaptureAnalyzeDock() {
        const dock = $('#livecapture-analyze-dock');
        const playlistsSec = $('#analyze-playlists-section');
        const game = AppState.getCurrentGame?.();
        const mode = AppState.get('mode');
        const isCapture = !!(game && game.video_source === 'liveCapture');
        const showDock = isCapture && mode === 'analyze';
        dock?.classList.toggle('hidden', !showDock);
        playlistsSec?.classList.toggle('hidden', !!showDock);
        syncLiveCaptureExportStrip();
    }

    AppState.on('liveRecordingBlockedNavigation', () => {
        UI.toast(
            'Hay una grabación en vivo activa. Detené la grabación antes de abrir otro proyecto o sincronizar.',
            'error'
        );
    });

    AppState.on('gameChanged', (game) => {
        resetLiveProbe();
        try {
            stopLivePreview();
        } catch (_) {
            /* noop */
        }
        if (!isLiveRecordingActive()) {
            try {
                YTPlayer.leaveLiveCapture?.();
            } catch (_) {
                /* noop */
            }
        }
        UI.updateNoGameOverlay();
        UI.updateProjectTitle();
        UI.renderAnalyzeClips();
        UI.renderAnalyzePlaylists();
        UI.renderViewClips();
        UI.renderViewSources();
        UI.updateClipEditControls();
        syncAnalyzeLiveCaptureTabVisibility();
        if (game) {
            if (game.local_video_url) {
                YTPlayer.loadLocalVideo(game.local_video_url);
            } else if (game.youtube_video_id) {
                YTPlayer.loadVideo(game.youtube_video_id);
            } else if (game.video_source === 'liveCapture') {
                const sid = `lc-${game.id}-${Date.now()}`;
                YTPlayer.loadLiveCapture?.({ sessionId: sid });
            }
        }
        setTimeout(updateLiveEdgeButton, 400);
        setTimeout(syncPlayerChromeUi, 0);
    });

    AppState.on('clipChanged', (clip) => {
        UI.renderAnalyzeClips();
        UI.renderViewClips();
        UI.updateClipEditControls();
        UI.updateFocusView();
    });

    AppState.on('clipsUpdated', () => {
        UI.renderAnalyzeClips();
        UI.renderViewClips();
    });

    AppState.on('playlistsUpdated', () => {
        UI.renderAnalyzePlaylists();
        UI.renderViewSources();
        if (AppState.get('mode') === 'view') {
            UI.renderViewClips();
        }
    });

    // ── Collection events ──
    AppState.on('collectionOpened', () => {
        // openCollection() ya fija modo Ver en AppState. No usar ?mode=view en la URL: se confunde
        // con enlaces de solo lectura (modal proyectos, etc.); el modo real va solo en estado.
        const u = new URL(window.location.href);
        u.searchParams.delete('project');
        u.searchParams.delete('game');
        u.searchParams.delete('playlist');
        u.searchParams.delete('editKey');
        u.searchParams.delete('mode');
        const qs = u.searchParams.toString();
        history.replaceState({}, '', u.pathname + (qs ? `?${qs}` : '') + u.hash);
        UI.updateCollectionBar();
        UI.updateNoGameOverlay();
        UI.updateMode();
        UI.renderViewClips();
        if (AppState.get('mode') === 'share') UI.renderSharePanel();
    });

    AppState.on('collectionClosed', () => {
        UI.updateCollectionBar();
        UI.updateNoGameOverlay();
        UI.updateMode();
        UI.renderViewClips();
        if (AppState.get('mode') === 'share') UI.renderSharePanel();
    });

    AppState.on('collectionItemsChanged', () => {
        UI.renderViewClips();
    });

    AppState.on('collectionItemChanged', async (item) => {
        if (!item) return;
        UI.renderViewClips();
        const currentVideoId = YTPlayer.getCurrentVideoId();
        if (item.youtubeVideoId && item.youtubeVideoId !== currentVideoId) {
            UI.toast('Cargando video…', 'info');
            await YTPlayer.loadVideoAsync(item.youtubeVideoId);
        }
        YTPlayer.playClip(item.startSec, item.endSec);
    });

    AppState.on('flagsUpdated', () => {
        UI.renderAnalyzeClips();
        UI.renderViewClips();
        UI.updateFocusView();
    });

    AppState.on('viewFiltersChanged', () => {
        UI.renderViewSources();
        UI.updateFlagFilterBar();
        UI.renderViewClips();
        // Show/hide reset button
        const hasFilters = AppState.get('activeTagFilters').length > 0 ||
            AppState.get('activePlaylistId') ||
            AppState.get('filterFlags').length > 0;

        const urlParams = new URLSearchParams(window.location.search);
        const isReadOnly = urlParams.get('mode') === 'view';
        const sharedPlaylistId = urlParams.get('playlist');

        // If the ONLY filter applied is the locked playlist, hide the reset button
        const isOnlyLockedPlaylist = isReadOnly && sharedPlaylistId &&
            AppState.get('activePlaylistId') === sharedPlaylistId &&
            AppState.get('activeTagFilters').length === 0 &&
            AppState.get('filterFlags').length === 0;

        const resetBtn = UI.$('#btn-reset-all-filters');
        if (resetBtn) resetBtn.style.display = (hasFilters && !isOnlyLockedPlaylist) ? 'inline-flex' : 'none';
    });

    AppState.on('panelToggled', () => {
        UI.updatePanelState();
    });

    AppState.on('focusViewToggled', () => {
        UI.updateFocusView();
        UI.updatePanelState();
    });

    AppState.on('tagTypesUpdated', () => {
        UI.renderTagButtons();
        UI.renderViewSources();
    });

    AppState.on('clipCommentsUpdated', () => {
        UI.renderNotifications();
    });

    // ═══════════════════════════════════════
    // DOM EVENT LISTENERS
    // ═══════════════════════════════════════

    // Mode toggle
    $('#btn-mode-analyze')?.addEventListener('click', () => {
        if (AppState.get('activeCollection')) return;
        AppState.setMode('analyze');
    });
    $('#btn-mode-view').addEventListener('click', () => AppState.setMode('view'));
    const btnModeShare = $('#btn-mode-share');
    if (btnModeShare) {
        btnModeShare.addEventListener('click', () => {
            if (!AppState.hasFeature(FEATURES.SHARE)) {
                UI.toast(getProFeatureMessage(), 'info');
                return;
            }
            AppState.setMode('share');
        });
    }

    // Novedades dropdown toggle
    const btnNovedades = $('#btn-novedades');
    const novedadesDropdown = $('#novedades-dropdown');
    if (btnNovedades && novedadesDropdown) {
        btnNovedades.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = novedadesDropdown.style.display === 'block';
            if (isOpen) {
                novedadesDropdown.style.display = 'none';
            } else {
                // Mark as seen — persist timestamp in localStorage
                const pid = AppState.get('currentProjectId');
                if (pid) {
                    localStorage.setItem('novedades_seen_' + pid, new Date().toISOString());
                }
                // Hide badge
                const badge = document.getElementById('novedades-badge');
                if (badge) badge.style.display = 'none';
                // Just render from current state — no reload (avoids video reset)
                UI.renderNotifications();
                // Keep badge hidden since user is looking
                if (badge) badge.style.display = 'none';
                novedadesDropdown.style.display = 'block';
            }
        });
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!novedadesDropdown.contains(e.target) && !btnNovedades.contains(e.target)) {
                novedadesDropdown.style.display = 'none';
            }
        });
    }

    // ── New Project Modal: Crear proyecto (fuente interna) vs Importar JSON ──
    let activeMainTab = 'create';
    /** Fuente dentro de «Crear proyecto»: youtube | local | capture */
    let activeCreateSource = 'yt';

    /** Ventana de código: solo en «Crear proyecto». */
    function updateNewProjectButtonboardRowVisibility() {
        const row = $('#new-project-buttonboard-row');
        if (row) row.classList.toggle('hidden', activeMainTab !== 'create');
    }

    function syncNewProjectPrimaryButton() {
        const btn = $('#btn-save-game');
        if (!btn) return;
        btn.textContent = activeMainTab === 'json' ? 'Importar proyecto' : 'Crear proyecto';
    }

    function syncNewProjectModalByPlan() {
        const hasLocalVideo = AppState.hasFeature(FEATURES.LOCAL_VIDEO);
        const hasImportData = AppState.hasFeature(FEATURES.IMPORT_DATA);
        const captureEnvOk = typeof canRunLiveCapture === 'function' && canRunLiveCapture();

        const jsonMainBtn = document.querySelector('#modal-new-game .tab-btn[data-main-tab="json"]');
        if (jsonMainBtn) {
            jsonMainBtn.classList.toggle('is-pro-locked', !hasImportData);
            jsonMainBtn.title = hasImportData ? 'Importar JSON' : 'Importar JSON — PRO';
        }

        if (!hasImportData && activeMainTab === 'json') {
            activeMainTab = 'create';
        }
        if (!hasLocalVideo && activeCreateSource === 'local') {
            activeCreateSource = 'yt';
        }
        if (!captureEnvOk && activeCreateSource === 'capture') {
            activeCreateSource = 'yt';
        }

        document.querySelectorAll('#modal-new-game .tab-btn[data-main-tab]').forEach((b) => {
            b.classList.toggle('active', b.dataset.mainTab === activeMainTab);
        });
        const paneCreate = $('#tab-content-create');
        const paneJson = $('#tab-content-json');
        if (paneCreate) paneCreate.classList.toggle('hidden', activeMainTab !== 'create');
        if (paneJson) paneJson.classList.toggle('hidden', activeMainTab !== 'json');

        document.querySelectorAll('#modal-new-game .new-project-source-chip').forEach((chip) => {
            const src = chip.dataset.createSource;
            chip.classList.toggle('active', src === activeCreateSource);
            if (src === 'local') chip.classList.toggle('is-pro-locked', !hasLocalVideo);
            if (src === 'capture') chip.classList.toggle('is-pro-locked', !captureEnvOk);
        });

        document.querySelectorAll('#modal-new-game .new-project-source-block').forEach((block) => {
            const key = block.dataset.sourceBlock;
            block.classList.toggle('hidden', activeMainTab !== 'create' || key !== activeCreateSource);
        });

        updateNewProjectButtonboardRowVisibility();
        syncNewProjectPrimaryButton();
    }

    // New project modal
    let _newProjectTemplates = [];

    $('#btn-new-game').addEventListener('click', async () => {
        syncNewProjectModalByPlan();
        $('#modal-new-game').classList.remove('hidden');
        ($('#input-game-title') || {}).focus?.();

        const hasTemplateChoice = AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES);
        const sel = $('#select-new-project-buttonboard');
        const fixed = $('#input-new-project-buttonboard-fixed');
        const hintPro = $('#hint-new-project-buttonboard-pro');
        const hintFree = $('#hint-new-project-buttonboard-free');

        if (sel) sel.classList.toggle('hidden', !hasTemplateChoice);
        if (fixed) fixed.classList.toggle('hidden', hasTemplateChoice);
        if (hintPro) hintPro.classList.toggle('hidden', !hasTemplateChoice);
        if (hintFree) hintFree.classList.toggle('hidden', hasTemplateChoice);

        if (hasTemplateChoice) {
            try {
                const uid = getCurrentUser() ? getCurrentUser().uid : null;
                const [sys, usr] = await Promise.all([
                    ButtonboardTemplates.getSystemTemplates(),
                    uid ? ButtonboardTemplates.getUserTemplates(uid) : [],
                ]);
                _newProjectTemplates = [...sys, ...usr];
                UI.populateButtonboardSelector(_newProjectTemplates);
            } catch (e) {
                console.warn('Could not load templates for selector:', e);
                _newProjectTemplates = [ButtonboardTemplates.BUILTIN_DEFAULT];
                UI.populateButtonboardSelector(_newProjectTemplates);
            }
        } else {
            _newProjectTemplates = [ButtonboardTemplates.BUILTIN_DEFAULT];
        }
        updateNewProjectButtonboardRowVisibility();
        syncNewProjectPrimaryButton();
    });

    $('#btn-cancel-game').addEventListener('click', () => {
        UI.hideModal('modal-new-game');
    });

    // Close modals on backdrop click (modal-buttonboards se cierra en app.js con confirmación si hay cambios)
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            const modal = backdrop.closest('.modal');
            if (!modal) return;
            if (modal.id === 'modal-buttonboards') return;
            if (modal.id === 'modal-session-conflict') return;
            modal.classList.add('hidden');
        });
    });

    document.querySelectorAll('#modal-new-game .tab-btn[data-main-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.mainTab === 'json' && !AppState.hasFeature(FEATURES.IMPORT_DATA)) {
                UI.toast(getProFeatureMessage(), 'info');
                return;
            }
            activeMainTab = btn.dataset.mainTab;
            document.querySelectorAll('#modal-new-game .tab-btn[data-main-tab]').forEach((b) => {
                b.classList.toggle('active', b === btn);
            });
            $('#tab-content-create')?.classList.toggle('hidden', activeMainTab !== 'create');
            $('#tab-content-json')?.classList.toggle('hidden', activeMainTab !== 'json');
            updateNewProjectButtonboardRowVisibility();
            syncNewProjectPrimaryButton();
            if (activeMainTab === 'create') $('#input-game-title')?.focus?.();
        });
    });

    document.querySelectorAll('#modal-new-game .new-project-source-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const src = chip.dataset.createSource;
            if (src === 'local' && !AppState.hasFeature(FEATURES.LOCAL_VIDEO)) {
                UI.toast(getProFeatureMessage(), 'info');
                return;
            }
            if (src === 'capture' && (typeof canRunLiveCapture !== 'function' || !canRunLiveCapture())) {
                UI.toast('La captura no está disponible en este entorno (HTTPS, navegador compatible).', 'info');
                return;
            }
            activeCreateSource = src;
            document.querySelectorAll('#modal-new-game .new-project-source-chip').forEach((c) => {
                c.classList.toggle('active', c.dataset.createSource === activeCreateSource);
            });
            document.querySelectorAll('#modal-new-game .new-project-source-block').forEach((block) => {
                block.classList.toggle('hidden', block.dataset.sourceBlock !== activeCreateSource);
            });
        });
    });

    $('#btn-save-game').addEventListener('click', async () => {
        if (activeMainTab === 'json') {
            if (!AppState.hasFeature(FEATURES.IMPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const jsonFile = $('#input-import-json').files[0];
            if (!jsonFile) { UI.toast('Seleccioná un archivo .json', 'error'); return; }

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    const game = AppState.importProjectData(data);

                    UI.hideModal('modal-new-game');
                    UI.toast(`Proyecto importado: ${game.title}`, 'success');
                    UI.refreshAll();

                    if (!game.youtube_video_id) {
                        UI.toast('Recordá vincular el archivo de video local si es necesario', 'info');
                    }
                } catch (err) {
                    UI.toast('Error al leer el archivo JSON', 'error');
                    console.error(err);
                }
            };
            reader.readAsText(jsonFile);
            return;
        }

        const title = ($('#input-game-title')?.value || '').trim();
        let ytId = null;
        let localVideoUrl = null;

        if (activeCreateSource === 'yt') {
            const rawYtInput = ($('#input-youtube-id')?.value || '').trim();
            if (!title) { UI.toast('Ingresá un título', 'error'); return; }
            if (!rawYtInput) { UI.toast('Ingresá un link de YouTube', 'error'); return; }
            ytId = extractYouTubeId(rawYtInput);
            if (!ytId) { UI.toast('No se pudo extraer el Video ID de YouTube', 'error'); return; }

        } else if (activeCreateSource === 'local') {
            if (!AppState.hasFeature(FEATURES.LOCAL_VIDEO)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const localVideoInput = $('#input-local-video')?.files?.[0];
            if (!title) { UI.toast('Ingresá un título', 'error'); return; }
            if (!localVideoInput) { UI.toast('Seleccioná un video local', 'error'); return; }
            localVideoUrl = URL.createObjectURL(localVideoInput);
            _localVideoFileForCurrentGame = localVideoInput;

        } else if (activeCreateSource === 'capture') {
            if (typeof canRunLiveCapture !== 'function' || !canRunLiveCapture()) {
                UI.toast('La captura no está disponible en este entorno.', 'info');
                return;
            }
            if (!title) { UI.toast('Ingresá un título', 'error'); return; }

            AppState.clearProject();
            DemoData.clear();
            resetShellForNewLocalDraft();

            const game = AppState.addGame(title, '', null, { video_source: 'liveCapture' });
            AppState.setCurrentGame(game.id);

            try {
                const hasTemplateChoice = AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES);
                const sel = $('#select-new-project-buttonboard');
                const selectedId = hasTemplateChoice && sel ? sel.value : ButtonboardTemplates.BUILTIN_DEFAULT.id;
                const selectedTemplate = selectedId
                    ? _newProjectTemplates.find(t => t.id === selectedId)
                    : null;
                const fallbackTemplate = selectedTemplate || ButtonboardTemplates.BUILTIN_DEFAULT;
                if (fallbackTemplate) {
                    const copy = ButtonboardTemplates.cloneTemplateForProject(fallbackTemplate);
                    AppState.setActiveButtonboards([copy]);
                }
            } catch (e) {
                console.warn('Could not apply buttonboard template:', e);
            }

            UI.hideModal('modal-new-game');
            $('#input-game-title').value = '';
            $('#input-youtube-id').value = '';
            $('#input-local-video').value = '';
            $('#input-import-json').value = '';

            UI.toast(`Proyecto creado: ${title}`, 'success');
            UI.refreshAll();
            try {
                _switchAnalyzeTabRef?.('livecapture');
            } catch (_) {
                /* noop */
            }
            return;
        }

        AppState.clearProject();
        DemoData.clear();
        resetShellForNewLocalDraft();

        const game = AppState.addGame(title, ytId, localVideoUrl);
        AppState.setCurrentGame(game.id);

        try {
            const hasTemplateChoice = AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES);
            const sel = $('#select-new-project-buttonboard');
            const selectedId = hasTemplateChoice && sel ? sel.value : ButtonboardTemplates.BUILTIN_DEFAULT.id;
            const selectedTemplate = selectedId
                ? _newProjectTemplates.find(t => t.id === selectedId)
                : null;
            const fallbackTemplate = selectedTemplate || ButtonboardTemplates.BUILTIN_DEFAULT;
            if (fallbackTemplate) {
                const copy = ButtonboardTemplates.cloneTemplateForProject(fallbackTemplate);
                AppState.setActiveButtonboards([copy]);
            }
        } catch (e) {
            console.warn('Could not apply buttonboard template:', e);
        }

        UI.hideModal('modal-new-game');

        $('#input-game-title').value = '';
        $('#input-youtube-id').value = '';
        $('#input-local-video').value = '';
        $('#input-import-json').value = '';

        UI.toast(`Proyecto creado: ${title}`, 'success');
        UI.refreshAll();

        if (localVideoUrl) {
            YTPlayer.loadLocalVideo(localVideoUrl, _localVideoFileForCurrentGame);
            AppState.setLocalVideoFile(_localVideoFileForCurrentGame);
        } else if (ytId) {
            YTPlayer.loadVideo(ytId);
        }
    });

    // Relink local video
    const btnRelink = $('#btn-relink-video');
    const inputRelink = $('#input-relink-video');
    if (btnRelink && inputRelink) {
        btnRelink.addEventListener('click', () => {
            if (!AppState.hasFeature(FEATURES.LOCAL_VIDEO)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            inputRelink.click();
        });
        inputRelink.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const url = URL.createObjectURL(file);
            const game = AppState.getCurrentGame();
            if (game) {
                game.local_video_url = url;
                if (game.video_source === 'liveCapture') {
                    delete game.video_source;
                }
                _localVideoFileForCurrentGame = file;
                AppState.setLocalVideoFile(file);
                YTPlayer.loadLocalVideo(url, file);
                UI.toast('Video re-vinculado ✅', 'success');
                syncAnalyzeLiveCaptureTabVisibility();
            }
        });
    }

    // Panel collapse
    $('#btn-collapse-panel').addEventListener('click', () => AppState.togglePanel());
    $('#btn-expand-panel').addEventListener('click', () => AppState.togglePanel());

    // Clip edit buttons
    $('#clip-edit-controls').addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (!action) return;
        const clipId = AppState.get('currentClipId');
        if (!clipId) return;

        switch (action) {
            case 'in-minus': AppState.updateClipBounds(clipId, 'start_sec', -1); break;
            case 'in-plus': AppState.updateClipBounds(clipId, 'start_sec', 1); break;
            case 'out-minus': AppState.updateClipBounds(clipId, 'end_sec', -1); break;
            case 'out-plus': AppState.updateClipBounds(clipId, 'end_sec', 1); break;
            case 'delete-clip':
                if (confirm('⚠️ ¿Eliminar este clip?\n\nEsta acción no se puede deshacer.')) {
                    AppState.deleteClip(clipId);
                    UI.toast('Clip eliminado', 'success');
                }
                break;
        }
    });

    // Source group toggles (collapsible Tags/Playlists in View mode)
    document.querySelectorAll('.source-group-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const targetId = toggle.dataset.toggle;
            const body = document.getElementById(targetId);
            if (!body) return;
            const isCollapsed = body.classList.contains('collapsed');
            body.classList.toggle('collapsed', !isCollapsed);
            toggle.classList.toggle('open', isCollapsed);
        });
    });

    // Create playlist
    $('#btn-create-playlist').addEventListener('click', () => {
        const nameInput = $('#new-playlist-name');
        const name = nameInput.value.trim();
        if (!name) { UI.toast('Ingresá un nombre', 'error'); return; }
        if (!AppState.get('currentGameId')) { UI.toast('Primero seleccioná un partido', 'error'); return; }
        const newPl = AppState.addPlaylist(name);
        AppState.addActivity('playlist_created', { playlistName: name, playlistId: newPl.id });
        nameInput.value = '';
        UI.toast(`Playlist creada: ${name}`, 'success');
    });

    // View mode playlist creation
    const btnViewCreatePl = $('#btn-view-create-playlist');
    if (btnViewCreatePl) {
        btnViewCreatePl.addEventListener('click', () => {
            const nameInput = $('#view-new-playlist-name');
            const name = nameInput.value.trim();
            if (!name) { UI.toast('Ingresá un nombre', 'error'); return; }
            if (!AppState.get('currentGameId')) { UI.toast('Primero seleccioná un partido', 'error'); return; }
            const newPl = AppState.addPlaylist(name);
            AppState.addActivity('playlist_created', { playlistName: name, playlistId: newPl.id });
            nameInput.value = '';
            UI.toast(`Playlist creada: ${name}`, 'success');
        });
    }

    // ── Active Playlist Header Actions ──
    const btnPlExport = $('#btn-pl-export');
    if (btnPlExport) {
        btnPlExport.addEventListener('click', () => {
            const playlistId = AppState.get('activePlaylistId');
            if (!playlistId) return;
            const pl = AppState.get('playlists').find(p => p.id === playlistId);
            UI.handlePlaylistExport(btnPlExport, playlistId, pl ? pl.name : 'playlist');
        });
    }

    const btnPlClose = $('#btn-pl-close');
    if (btnPlClose) {
        btnPlClose.addEventListener('click', () => {
            AppState.clearPlaylistFilter();
        });
    }

    const btnPlShare = $('#btn-pl-share');
    if (btnPlShare) {
        btnPlShare.addEventListener('click', async () => {
            if (!AppState.hasFeature(FEATURES.SHARE)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const playlistId = AppState.get('activePlaylistId');
            if (!playlistId) return;
            let projectId = AppState.get('currentProjectId');
            if (!projectId) {
                UI.toast('Primero guardá el proyecto para compartir', 'error');
                return;
            }
            const url = FirebaseData.getShareUrl(projectId, null, playlistId) + '&mode=view';
            navigator.clipboard.writeText(url).then(() => {
                UI.toast('🔗 Link de Playlist copiado', 'success');
            }).catch(() => {
                prompt('Copiá este link:', url);
            });
        });
    }

    const btnPlWa = $('#btn-pl-wa');
    if (btnPlWa) {
        btnPlWa.addEventListener('click', () => {
            if (!AppState.hasFeature(FEATURES.SHARE)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const playlistId = AppState.get('activePlaylistId');
            if (!playlistId) return;
            const projectId = AppState.get('currentProjectId');
            if (!projectId) {
                UI.toast('Primero guardá el proyecto para compartir', 'error');
                return;
            }
            const url = FirebaseData.getShareUrl(projectId, null, playlistId) + '&mode=view';
            const msg = encodeURIComponent('Playlist de análisis:\n' + url);
            window.open('https://wa.me/?text=' + msg, '_blank');
        });
    }

    const btnPlRename = $('#btn-pl-rename');
    if (btnPlRename) {
        btnPlRename.addEventListener('click', () => {
            const playlistId = AppState.get('activePlaylistId');
            if (!playlistId) return;
            const playlists = AppState.get('playlists');
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            const newName = prompt('Nuevo nombre para la playlist:', pl.name);
            if (newName && newName.trim()) {
                AppState.renamePlaylist(playlistId, newName.trim());
                UI.toast(`Playlist renombrada: ${newName.trim()}`, 'success');
            }
        });
    }

    const btnPlDelete = $('#btn-pl-delete');
    if (btnPlDelete) {
        btnPlDelete.addEventListener('click', () => {
            const playlistId = AppState.get('activePlaylistId');
            if (!playlistId) return;
            const playlists = AppState.get('playlists');
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            if (confirm(`⚠️ ¿Eliminar la playlist "${pl.name}"?\n\nSe perderán todos los clips asociados a esta playlist.\nEsta acción no se puede deshacer.`)) {
                AppState.clearPlaylistFilter();
                AppState.deletePlaylist(playlistId);
                UI.toast(`Playlist eliminada: ${pl.name}`, 'success');
            }
        });
    }

    /** Cierre del modal de ventanas de código con confirmación si hay edición sin guardar (asignado en el bloque de wiring). */
    let _bbHideButtonboardsModal = () => true;

    // ═══ BUTTONBOARDS PANEL WIRING (PRO) ═══
    {
        // State for the panel
        let _bbSystemTemplates = [];
        let _bbUserTemplates = [];
        let _bbEditorMode = null;       // 'new' | 'edit'
        let _bbEditorTemplate = null;   // template being edited
        let _bbEditorButtons = [];      // mutable copy for the editor
        /** JSON de { name, buttons } al abrir el editor, para detectar cambios sin guardar */
        let _bbEditorSnapshot = null;

        function _bbSetEditorUiState(isEditing) {
            const modal = $('#modal-buttonboards');
            const box = $('#modal-buttonboards-box');
            const browserEl = $('#bb-browser');
            const editorEl = $('#bb-editor');

            if (modal) modal.classList.toggle('bb-editor-mode', isEditing);
            if (box) box.classList.toggle('bb-editor-mode', isEditing);
            if (browserEl) browserEl.style.display = isEditing ? 'none' : '';
            if (editorEl) {
                editorEl.style.display = isEditing ? 'flex' : 'none';
            }
        }

        function _bbGetUid() {
            const u = getCurrentUser();
            return u ? u.uid : null;
        }

        function _bbCaptureEditorSnapshot() {
            const nameEl = $('#bb-editor-name');
            const name = nameEl ? String(nameEl.value || '').trim() : '';
            const buttons = UI.readBBEditorButtons();
            return JSON.stringify({ name, buttons });
        }

        function _bbIsEditorDirty() {
            if (!_bbEditorMode || _bbEditorSnapshot === null) return false;
            return _bbCaptureEditorSnapshot() !== _bbEditorSnapshot;
        }

        function _bbConfirmDiscardIfDirty() {
            if (!_bbIsEditorDirty()) return true;
            return confirm('Tenés cambios sin guardar en este template. ¿Salir y descartarlos?');
        }

        _bbHideButtonboardsModal = function () {
            if (!_bbConfirmDiscardIfDirty()) return false;
            _bbCloseEditor();
            UI.hideModal('modal-buttonboards');
            return true;
        };

        function _bbAttemptLeaveEditor() {
            if (!_bbConfirmDiscardIfDirty()) return;
            _bbCloseEditor();
        }

        async function _bbLoadAndRender() {
            const uid = _bbGetUid();
            try {
                [_bbSystemTemplates, _bbUserTemplates] = await Promise.all([
                    ButtonboardTemplates.getSystemTemplates(),
                    uid ? ButtonboardTemplates.getUserTemplates(uid) : [],
                ]);
            } catch (e) {
                console.warn('Error loading buttonboard templates:', e);
                _bbSystemTemplates = [ButtonboardTemplates.BUILTIN_DEFAULT];
                _bbUserTemplates = [];
            }
            _bbRenderPanel();
        }

        function _bbPopulateBasedOnDropdown() {
            const sel = $('#bb-editor-based-on');
            if (!sel) return;
            sel.innerHTML = '';
            const opt0 = document.createElement('option');
            opt0.value = '';
            opt0.textContent = 'Empezar en blanco';
            sel.appendChild(opt0);
            if ((_bbSystemTemplates || []).length) {
                const ogSys = document.createElement('optgroup');
                ogSys.label = 'Templates del sistema';
                _bbSystemTemplates.forEach((tpl) => {
                    const o = document.createElement('option');
                    o.value = 's:' + encodeURIComponent(tpl.id);
                    o.textContent = tpl.name || tpl.id;
                    ogSys.appendChild(o);
                });
                sel.appendChild(ogSys);
            }
            if ((_bbUserTemplates || []).length) {
                const ogUser = document.createElement('optgroup');
                ogUser.label = 'Mis templates';
                _bbUserTemplates.forEach((tpl) => {
                    const o = document.createElement('option');
                    o.value = 'u:' + encodeURIComponent(tpl.id);
                    o.textContent = tpl.name || tpl.id;
                    ogUser.appendChild(o);
                });
                sel.appendChild(ogUser);
            }
        }

        function _bbResolveBasedOnTemplate(val) {
            if (!val) return null;
            const idx = val.indexOf(':');
            if (idx < 1) return null;
            const kind = val.slice(0, idx);
            const id = decodeURIComponent(val.slice(idx + 1));
            if (kind === 's') return (_bbSystemTemplates || []).find((t) => t.id === id) || null;
            if (kind === 'u') return (_bbUserTemplates || []).find((t) => t.id === id) || null;
            return null;
        }

        function _bbWireBasedOnSelect() {
            const sel = $('#bb-editor-based-on');
            if (!sel || sel.dataset.bbWired) return;
            sel.dataset.bbWired = '1';
            sel.addEventListener('change', () => {
                if (_bbEditorMode !== 'new') return;
                const tpl = _bbResolveBasedOnTemplate(sel.value);
                _bbEditorButtons = ButtonboardTemplates.cloneButtons(tpl ? tpl.buttons : []);
                UI.renderBBEditorButtons(_bbEditorButtons);
            });
        }

        function _bbRenderPanel() {
            UI.renderButtonboardsPanel(_bbSystemTemplates, _bbUserTemplates, {
                onUse: (tpl) => {
                    const copy = ButtonboardTemplates.cloneTemplateForProject(tpl);
                    AppState.setActiveButtonboards([copy]);
                    UI.toast(`Ventana de código "${tpl.name}" cargada en el proyecto`, 'success');
                    UI.renderTagButtons();
                },
                onEdit: (tpl) => _bbOpenEditor('edit', tpl),
                onDuplicate: async (tpl) => {
                    const uid = _bbGetUid();
                    if (!uid) { UI.toast('Iniciá sesión para duplicar', 'error'); return; }
                    await ButtonboardTemplates.duplicateTemplate(uid, tpl);
                    UI.toast('Template duplicado', 'success');
                    await _bbLoadAndRender();
                },
                onDelete: async (tpl) => {
                    if (!confirm(`¿Borrar template "${tpl.name}"?`)) return;
                    const uid = _bbGetUid();
                    if (!uid) return;
                    await ButtonboardTemplates.deleteUserTemplate(uid, tpl.id);
                    UI.toast('Template borrado', 'success');
                    await _bbLoadAndRender();
                },
            });
        }

        function _bbOpenEditor(mode, template = null) {
            _bbEditorMode = mode;
            _bbEditorTemplate = template;
            _bbEditorButtons = ButtonboardTemplates.cloneButtons(template ? template.buttons : []);
            const titleEl = $('#bb-editor-title');
            const nameEl = $('#bb-editor-name');
            const basedRow = $('#bb-editor-based-row');
            const basedSel = $('#bb-editor-based-on');
            if (titleEl) titleEl.textContent = mode === 'edit' ? 'Editar template' : 'Nuevo template';
            if (nameEl) nameEl.value = template ? template.name : '';
            if (basedRow) basedRow.hidden = mode !== 'new';
            if (mode === 'new' && basedSel) {
                _bbPopulateBasedOnDropdown();
                basedSel.value = '';
            }
            _bbWireBasedOnSelect();
            _bbSetEditorUiState(true);
            UI.renderBBEditorButtons(_bbEditorButtons);
            _bbEditorSnapshot = _bbCaptureEditorSnapshot();
        }

        function _bbCloseEditor() {
            _bbEditorMode = null;
            _bbEditorTemplate = null;
            _bbEditorButtons = [];
            _bbEditorSnapshot = null;
            _bbSetEditorUiState(false);
        }

        // Open panel
        const btnOpen = $('#btn-open-buttonboards');
        if (btnOpen) {
            btnOpen.addEventListener('click', async () => {
                if (!AppState.hasFeature(FEATURES.BUTTONBOARD_TEMPLATES)) {
                    UI.toast(getProFeatureMessage(), 'info');
                    return;
                }
                UI.showModal('modal-buttonboards');
                _bbCloseEditor();
                await _bbLoadAndRender();
            });
        }

        // Close panel
        $('#btn-close-buttonboards') && $('#btn-close-buttonboards').addEventListener('click', () => {
            _bbHideButtonboardsModal();
        });

        // New template
        $('#btn-bb-new-template') && $('#btn-bb-new-template').addEventListener('click', () => {
            _bbOpenEditor('new');
        });

        // Editor: add button
        $('#btn-bb-editor-add-btn') && $('#btn-bb-editor-add-btn').addEventListener('click', () => {
            _bbEditorButtons.push({
                id: 'tag-new-' + Date.now().toString(36),
                key: 'nuevo',
                label: 'Nuevo',
                row: 'top',
                pre_sec: 3,
                post_sec: 8,
                order: _bbEditorButtons.length,
            });
            UI.renderBBEditorButtons(_bbEditorButtons);
        });

        // Editor: save
        $('#btn-bb-editor-save') && $('#btn-bb-editor-save').addEventListener('click', async () => {
            const uid = _bbGetUid();
            if (!uid) { UI.toast('Iniciá sesión para guardar', 'error'); return; }
            const nameEl = $('#bb-editor-name');
            const name = nameEl ? nameEl.value.trim() : '';
            if (!name) { UI.toast('Ingresá un nombre', 'error'); return; }
            const buttons = UI.readBBEditorButtons();
            const toSave = {
                id: _bbEditorTemplate ? _bbEditorTemplate.id : undefined,
                name,
                buttons,
            };
            try {
                await ButtonboardTemplates.saveUserTemplate(uid, toSave);
                UI.toast(`Template "${name}" guardado`, 'success');
                _bbCloseEditor();
                await _bbLoadAndRender();
            } catch (e) {
                UI.toast('Error al guardar: ' + e.message, 'error');
                console.error(e);
            }
        });

        // Editor: cancel / back to list
        $('#btn-bb-editor-cancel') && $('#btn-bb-editor-cancel').addEventListener('click', _bbAttemptLeaveEditor);
        $('#btn-bb-editor-close') && $('#btn-bb-editor-close').addEventListener('click', _bbAttemptLeaveEditor);
        const btnBbBack = $('#btn-bb-back-to-list');
        if (btnBbBack) btnBbBack.addEventListener('click', _bbAttemptLeaveEditor);

        // Save current project board as template
        $('#btn-bb-save-as-template') && $('#btn-bb-save-as-template').addEventListener('click', async () => {
            const uid = _bbGetUid();
            if (!uid) { UI.toast('Iniciá sesión para guardar templates', 'error'); return; }
            const bbs = AppState.get('activeButtonboards');
            if (!bbs || bbs.length === 0) { UI.toast('No hay ventana de código activa en el proyecto', 'error'); return; }
            const current = bbs[0];
            try {
                await ButtonboardTemplates.saveUserTemplate(uid, {
                    name: current.name + ' (guardado)',
                    buttons: ButtonboardTemplates.cloneButtons(current.buttons),
                });
                UI.toast(`Ventana de código guardada como template: "${current.name}"`, 'success');
                await _bbLoadAndRender();
            } catch (e) {
                UI.toast('Error al guardar: ' + e.message, 'error');
                console.error(e);
            }
        });

        // Backdrop click to close
        const bbModal = $('#modal-buttonboards');
        const bbBackdrop = bbModal ? bbModal.querySelector('.modal-backdrop') : null;
        if (bbBackdrop) {
            bbBackdrop.addEventListener('click', () => _bbHideButtonboardsModal());
        }

        // React to buttonboardsChanged (e.g. tag buttons re-render)
        AppState.on('buttonboardsChanged', () => UI.renderTagButtons());
    }


    $('#btn-add-selected-to-playlist').addEventListener('click', () => {
        const selected = UI.getSelectedClipIds();
        if (selected.length === 0) { UI.toast('Seleccioná al menos un clip', 'error'); return; }

        const playlists = AppState.get('playlists');
        if (playlists.length === 0) { UI.toast('Creá una playlist primero (o creala en el modal)', 'error'); }

        UI.showAddToPlaylistModal(selected);
    });

    // Create playlist from modal
    $('#btn-create-playlist-modal').addEventListener('click', () => {
        const nameInput = $('#new-playlist-name-modal');
        const name = nameInput.value.trim();
        if (!name) { UI.toast('Ingresá un nombre', 'error'); return; }
        if (!AppState.get('currentGameId')) { UI.toast('Primero seleccioná un partido', 'error'); return; }

        const newPl = AppState.addPlaylist(name);
        AppState.addActivity('playlist_created', { playlistName: name, playlistId: newPl.id });
        nameInput.value = '';
        UI.toast(`Playlist creada: ${name}`, 'success');
        if (UI.renderPlaylistModalList) {
            UI.renderPlaylistModalList();
        }
    });

    $('#new-playlist-name-modal').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#btn-create-playlist-modal').click();
    });

    // Enter key on playlist name
    $('#new-playlist-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#btn-create-playlist').click();
    });

    // ═══ PROJECTS LIST ═══
    async function openProjectsModal() {
        const urlParams = new URLSearchParams(window.location.search);
        // Solo bloqueo de lectura: enlaces compartidos (típ. ?project=...&mode=view), no la vista Ver normal ni colección
        const isReadOnly = urlParams.get('mode') === 'view' && (!!urlParams.get('project') || !!urlParams.get('playlist'));
        if (isReadOnly) {
            UI.toast('El explorador de proyectos no está disponible en modo lectura', 'info');
            return;
        }
        if (isLiveRecordingActive()) {
            UI.toast(
                'Hay una grabación en vivo activa. Detené la grabación antes de abrir otro proyecto.',
                'error'
            );
            return;
        }

        UI.showModal('modal-projects');
        const listOwned = $('#project-list');
        const listShared = $('#shared-project-list');
        const foldersSummary = $('#project-folders-summary');
        const currentUser = getCurrentUser();
        const folderUserId = currentUser?.uid || AppState.get('userId');
        const hasShareFeature = AppState.hasFeature(FEATURES.SHARE);
        const canUseFolders = !!folderUserId && folderUserId !== 'anonymous';
        const sharedTitle = listShared ? listShared.previousElementSibling : null;
        const sharedCountEl = $('#shared-projects-count');
        const sharedChevronEl = $('#shared-projects-chevron');
        let sharedSectionExpanded = false;
        let sharedProjectsCount = 0;
        let folderState = { folders: [], projectMap: {} };
        let ownedProjectsCache = [];

        const updateSharedSectionUI = () => {
            if (!hasShareFeature) {
                if (listShared) listShared.style.display = 'none';
                if (sharedTitle) sharedTitle.style.display = 'none';
                return;
            }
            if (sharedTitle) sharedTitle.style.display = '';
            if (sharedCountEl) sharedCountEl.textContent = String(sharedProjectsCount);
            if (sharedChevronEl) sharedChevronEl.textContent = sharedSectionExpanded ? '▾' : '▸';
            if (listShared) listShared.style.display = sharedSectionExpanded ? '' : 'none';
        };
        if (sharedTitle) {
            sharedTitle.onclick = () => {
                sharedSectionExpanded = !sharedSectionExpanded;
                updateSharedSectionUI();
            };
        }
        updateSharedSectionUI();

        listOwned.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px;">Cargando...</p>';
        if (listShared) {
            listShared.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px;">Cargando...</p>';
        }

        const sortAlpha = (arr, field) => arr.slice().sort((a, b) =>
            String(a?.[field] || '').localeCompare(String(b?.[field] || ''), 'es', { sensitivity: 'base', numeric: true })
        );
        const sortedFolders = () => sortAlpha(folderState.folders || [], 'name');
        const getProjectFolderIds = (projectId) => {
            const raw = folderState?.projectMap?.[projectId];
            if (Array.isArray(raw)) return raw.filter(Boolean);
            if (typeof raw === 'string' && raw) return [raw];
            return [];
        };
        const setProjectFolderIds = (projectId, folderIds) => {
            const clean = Array.from(new Set((folderIds || []).filter(Boolean)));
            if (!clean.length) delete folderState.projectMap[projectId];
            else folderState.projectMap[projectId] = clean;
        };
        let _folderSaveTimer = null;
        let _folderSaveInFlight = false;
        let _folderSaveQueuedWhileBusy = false;
        let activeFolderFilterId = '';
        const RECENT_FILTER_KEY = '__recent__';
        const NO_FOLDER_FILTER_KEY = '__none__';
        const queueFolderStateSave = () => {
            if (!canUseFolders) return;
            if (_folderSaveTimer) clearTimeout(_folderSaveTimer);
            _folderSaveTimer = setTimeout(async () => {
                _folderSaveTimer = null;
                if (_folderSaveInFlight) {
                    _folderSaveQueuedWhileBusy = true;
                    return;
                }
                _folderSaveInFlight = true;
                try {
                    await FirebaseData.saveUserProjectFolders(folderUserId, folderState);
                } catch (e) {
                    console.error('Save folder state error:', e);
                    UI.toast('No se pudo guardar carpetas', 'error');
                } finally {
                    _folderSaveInFlight = false;
                    if (_folderSaveQueuedWhileBusy) {
                        _folderSaveQueuedWhileBusy = false;
                        queueFolderStateSave();
                    }
                }
            }, 140);
        };
        let projectSearchQuery = '';
        const collapsedFolderKeys = new Set();
        let folderCollapseInitialized = false;

        const normalizeText = (v) => String(v || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');

        const getUpdatedMs = (p) => {
            if (p?.updatedAt instanceof Date) return p.updatedAt.getTime();
            if (typeof p?.updatedAt?.toDate === 'function') return p.updatedAt.toDate().getTime();
            if (typeof p?.updated_at === 'number') return p.updated_at;
            return 0;
        };

        const createFolderFromInline = async (rawName) => {
            if (!canUseFolders) return null;
            const name = String(rawName || '').trim();
            if (!name) return null;
            const exists = folderState.folders.some((f) => String(f.name).toLowerCase() === name.toLowerCase());
            if (exists) {
                UI.toast('Esa carpeta ya existe', 'info');
                return folderState.folders.find((f) => String(f.name).toLowerCase() === name.toLowerCase())?.id || null;
            }
            const folderId = `fld_${Date.now().toString(36)}`;
            folderState.folders.push({ id: folderId, name });
            folderState.folders = sortAlpha(folderState.folders, 'name');
            queueFolderStateSave();
            return folderId;
        };

        const getOwnedProjectsInFolder = (folderId) =>
            ownedProjectsCache.filter((p) => getProjectFolderIds(p.id).includes(folderId));

        const removeFolderEverywhere = (folderId, targetFolderId = null) => {
            Object.keys(folderState.projectMap || {}).forEach((projectId) => {
                const current = getProjectFolderIds(projectId);
                if (!current.includes(folderId)) return;
                const stripped = current.filter((id) => id !== folderId);
                const merged = targetFolderId ? Array.from(new Set([...stripped, targetFolderId])) : stripped;
                setProjectFolderIds(projectId, merged);
            });
            folderState.folders = (folderState.folders || []).filter((f) => f.id !== folderId);
            if (activeFolderFilterId === folderId) activeFolderFilterId = '';
            collapsedFolderKeys.delete(folderId);
        };

        const renameFolder = async (folderId) => {
            const f = (folderState.folders || []).find((x) => x.id === folderId);
            if (!f) return;
            const nextName = prompt('Nuevo nombre de la carpeta:', f.name);
            if (!nextName) return;
            const clean = String(nextName).trim();
            if (!clean || clean === f.name) return;
            const duplicated = (folderState.folders || []).some((x) =>
                x.id !== folderId && String(x.name || '').toLowerCase() === clean.toLowerCase()
            );
            if (duplicated) {
                UI.toast('Ya existe una carpeta con ese nombre', 'error');
                return;
            }
            f.name = clean;
            folderState.folders = sortAlpha(folderState.folders, 'name');
            queueFolderStateSave();
            renderOwnedWithFolders();
            ensureProjectsSearchUI();
            UI.toast('Carpeta renombrada', 'success');
        };

        const deleteFolderWithStrategy = async (folderId) => {
            const folder = (folderState.folders || []).find((f) => f.id === folderId);
            if (!folder) return;
            const projectsInFolder = getOwnedProjectsInFolder(folderId);
            const count = projectsInFolder.length;
            const option = prompt(
                `Eliminar carpeta "${folder.name}" (${count} proyecto${count === 1 ? '' : 's'}).\n\n` +
                `1 = Dejar proyectos sin carpeta\n` +
                `2 = Transferir proyectos a otra carpeta\n` +
                `3 = Eliminar todos los proyectos de esta carpeta\n\n` +
                `Escribí 1, 2 o 3`
            );
            if (!option) return;
            const choice = option.trim();
            if (!['1', '2', '3'].includes(choice)) {
                UI.toast('Opción inválida. Escribí 1, 2 o 3.', 'error');
                return;
            }

            if (choice === '1') {
                removeFolderEverywhere(folderId, null);
                queueFolderStateSave();
                renderOwnedWithFolders();
                ensureProjectsSearchUI();
                UI.toast('Carpeta eliminada. Proyectos movidos a "Sin carpeta".', 'success');
                return;
            }

            if (choice === '2') {
                const candidates = (folderState.folders || []).filter((f) => f.id !== folderId);
                if (!candidates.length) {
                    UI.toast('No hay otra carpeta para transferir. Creá una primero.', 'info');
                    return;
                }
                const numbered = candidates.map((f, i) => `${i + 1} = ${f.name}`).join('\n');
                const targetAnswer = prompt(
                    `Elegí carpeta destino para "${folder.name}":\n\n${numbered}\n\nEscribí el número`
                );
                if (!targetAnswer) return;
                const idx = Number(targetAnswer) - 1;
                if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
                    UI.toast('Destino inválido.', 'error');
                    return;
                }
                const target = candidates[idx];
                removeFolderEverywhere(folderId, target.id);
                queueFolderStateSave();
                renderOwnedWithFolders();
                ensureProjectsSearchUI();
                UI.toast(`Carpeta eliminada. Proyectos transferidos a "${target.name}".`, 'success');
                return;
            }

            const confirmDelete = confirm(
                `⚠️ Esto eliminará ${count} proyecto${count === 1 ? '' : 's'} de la nube y no se puede deshacer.\n\n¿Continuar?`
            );
            if (!confirmDelete) return;
            try {
                for (const p of projectsInFolder) {
                    await FirebaseData.deleteProjectCloud(p.id);
                }
                ownedProjectsCache = ownedProjectsCache.filter((p) => !projectsInFolder.some((x) => x.id === p.id));
                removeFolderEverywhere(folderId, null);
                queueFolderStateSave();
                renderOwnedWithFolders();
                ensureProjectsSearchUI();
                UI.toast(
                    `Carpeta eliminada. ${count} proyecto${count === 1 ? '' : 's'} eliminado${count === 1 ? '' : 's'}.`,
                    'success'
                );
            } catch (e) {
                console.error('deleteFolderWithStrategy:', e);
                UI.toast(`No se pudo eliminar carpeta/proyectos: ${e?.message || e}`, 'error');
            }
        };

        const renderFolderAdminPanel = () => {
            const panel = $('#project-folder-admin-panel');
            const list = $('#project-folder-admin-list');
            if (!panel || !list) return;
            if (panel.classList.contains('hidden')) return;
            if (!canUseFolders) {
                list.innerHTML = '<p style="color:var(--text-muted);font-size:.78rem;">Iniciá sesión para administrar carpetas y guardarlas en la nube.</p>';
                return;
            }
            const folders = sortedFolders();
            list.innerHTML = '';
            if (!folders.length) {
                list.innerHTML = '<p style="color:var(--text-muted);font-size:.78rem;">No hay carpetas creadas todavía.</p>';
                return;
            }
            folders.forEach((folder) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;';
                const count = getOwnedProjectsInFolder(folder.id).length;
                const name = document.createElement('div');
                name.style.cssText = 'font-size:.78rem;color:var(--text);';
                name.textContent = `${folder.name} (${count})`;
                const actions = document.createElement('div');
                actions.style.cssText = 'display:flex;gap:6px;';
                const btnRename = document.createElement('button');
                btnRename.type = 'button';
                btnRename.className = 'btn btn-xs btn-ghost';
                btnRename.textContent = 'Renombrar';
                btnRename.addEventListener('click', () => renameFolder(folder.id));
                const btnDelete = document.createElement('button');
                btnDelete.type = 'button';
                btnDelete.className = 'btn btn-xs btn-danger';
                btnDelete.textContent = 'Eliminar';
                btnDelete.addEventListener('click', () => deleteFolderWithStrategy(folder.id));
                actions.appendChild(btnRename);
                actions.appendChild(btnDelete);
                row.appendChild(name);
                row.appendChild(actions);
                list.appendChild(row);
            });
        };

        const ensureProjectsSearchUI = () => {
            const modalBox = listOwned?.closest('.modal-box');
            if (!modalBox) return;
            let wrap = $('#project-search-wrap');
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.id = 'project-search-wrap';
                wrap.className = 'project-search-wrap';
                wrap.innerHTML = `
                    <div style="display:flex;gap:8px;align-items:center;">
                        <input id="project-search-input" type="text" class="input-sm project-search-input" placeholder="Buscar proyecto..." />
                        <button id="btn-manage-folders" type="button" class="btn btn-xs btn-ghost" style="white-space:nowrap;">Administrar carpetas</button>
                    </div>
                    <div id="project-folder-admin-panel" class="hidden" style="margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:10px;background:rgba(18,20,26,.75);">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
                            <strong style="font-size:.76rem;color:var(--text-muted);">Carpetas</strong>
                            <button id="btn-close-manage-folders" type="button" class="btn btn-xs btn-ghost">Cerrar</button>
                        </div>
                        <div id="project-folder-admin-list"></div>
                    </div>
                `;
                listOwned.parentNode.insertBefore(wrap, listOwned);
            }
            const input = $('#project-search-input');
            if (input && !input.dataset.wiredProjectSearch) {
                input.dataset.wiredProjectSearch = '1';
                input.addEventListener('input', () => {
                    projectSearchQuery = input.value || '';
                    renderOwnedWithFolders();
                });
            }
            if (input) input.value = projectSearchQuery;

            const btnManage = $('#btn-manage-folders');
            if (btnManage && !btnManage.dataset.wiredManageFolders) {
                btnManage.dataset.wiredManageFolders = '1';
                btnManage.addEventListener('click', () => {
                    const panel = $('#project-folder-admin-panel');
                    if (!panel) return;
                    panel.classList.toggle('hidden');
                    if (!panel.classList.contains('hidden')) renderFolderAdminPanel();
                });
            }
            if (btnManage) btnManage.style.display = '';
            const btnCloseManage = $('#btn-close-manage-folders');
            if (btnCloseManage && !btnCloseManage.dataset.wiredCloseManageFolders) {
                btnCloseManage.dataset.wiredCloseManageFolders = '1';
                btnCloseManage.addEventListener('click', () => {
                    const panel = $('#project-folder-admin-panel');
                    if (panel) panel.classList.add('hidden');
                });
            }
        };

        const setActiveFolderFilter = (folderId = '') => {
            activeFolderFilterId = folderId || '';
            if (activeFolderFilterId && activeFolderFilterId !== RECENT_FILTER_KEY) {
                collapsedFolderKeys.delete(activeFolderFilterId);
            }
            renderOwnedWithFolders();
        };

        const renderList = (container, arr, { withFolders = false } = {}) => {
            container.innerHTML = '';
            if (arr.length === 0) {
                container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:16px;">No hay proyectos</p>';
                return;
            }

            const actionIcons = {
                share: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="M15 7a3 3 0 1 0-.07-1.97l-6.2 3.1a3 3 0 0 0 0 1.74l6.2 3.1A3 3 0 1 0 15 11l-6.2-3.1L15 4.8V7Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
                duplicate: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.8"/><rect x="5" y="5" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.8"/></svg>',
                rename: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="M4 20h4l9.7-9.7a1.9 1.9 0 0 0 0-2.6l-1.4-1.4a1.9 1.9 0 0 0-2.6 0L4 16v4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m12.7 7.3 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
                open: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="m9 6 8 6-8 6V6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
                view: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.8"/></svg>',
                delete: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="M4 7h16M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7m-8 0 1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
                move: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h4a2 2 0 0 1 1.4.6l.8.8a2 2 0 0 0 1.4.6h7.4A1.5 1.5 0 0 1 21 10.5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 12v5M9.5 14.5h5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>'
            };

            const renderProjectRow = (p) => {
                const el = document.createElement('div');
                el.className = 'project-item';
                el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'space-between';
                el.style.padding = '10px';
                el.style.gap = '8px';

                const dateStr = p.updatedAt ? p.updatedAt.toLocaleDateString() : '';
                const sourceLabel =
                    p.youtubeVideoId && String(p.youtubeVideoId).trim() ? 'YouTube' : 'Local';
                const datePart = dateStr
                    ? `<span class="project-date__when">${dateStr}</span><span class="project-meta-sep" aria-hidden="true">·</span>`
                    : '';
                const info = document.createElement('div');
                info.className = 'project-info';
                info.style.flex = '1';
                info.style.cursor = 'pointer';
                info.style.position = 'relative';
                info.innerHTML = `
                    <div class="project-title">${p.title}</div>
                    <div class="project-meta-line">
                        ${datePart}<span class="project-source-label">${sourceLabel}</span>
                    </div>
                `;

                const actions = document.createElement('div');
                actions.className = 'project-actions';
                actions.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

                if (withFolders && canUseFolders) {
                    const assignedFolderIds = getProjectFolderIds(p.id);
                    const updateFolderRowChecks = (box, selectedIds) => {
                        if (!box) return;
                        const idSet = new Set(selectedIds || []);
                        box.querySelectorAll('[data-folder-row-id]').forEach((rowEl) => {
                            const id = rowEl.dataset.folderRowId;
                            const mark = rowEl.querySelector('[data-folder-row-mark]');
                            if (mark) mark.textContent = idSet.has(id) ? '✓' : '';
                        });
                    };

                    const folderPickerWrap = document.createElement('div');
                    folderPickerWrap.className = 'project-folder-picker-wrap';
                    folderPickerWrap.style.cssText = 'position:absolute;right:0;top:calc(100% + 6px);bottom:auto;z-index:30;display:none;';
                    const pickerBox = document.createElement('div');
                    pickerBox.className = 'project-folder-picker-box';
                    pickerBox.style.cssText = 'display:grid;gap:2px;min-width:180px;max-width:220px;max-height:180px;overflow:auto;padding:4px;border:1px solid var(--border);border-radius:10px;background:rgba(18,20,26,.98);box-shadow:0 10px 28px rgba(0,0,0,.35);';

                    const folders = sortedFolders();
                    folders.forEach((f) => {
                        const row = document.createElement('button');
                        row.type = 'button';
                        row.className = 'btn btn-xs btn-ghost';
                        row.dataset.folderRowId = f.id;
                        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;padding:6px 8px;border-radius:7px;';
                        row.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span><span data-folder-row-mark style="opacity:.9;">${assignedFolderIds.includes(f.id) ? '✓' : ''}</span>`;
                        row.addEventListener('click', async () => {
                            const current = getProjectFolderIds(p.id);
                            const exists = current.includes(f.id);
                            const next = exists ? current.filter((id) => id !== f.id) : [...current, f.id];
                            setProjectFolderIds(p.id, next);
                            updateFolderRowChecks(pickerBox, next);
                            queueFolderStateSave();
                        });
                        pickerBox.appendChild(row);
                    });

                    const addFolderBtn = document.createElement('button');
                    addFolderBtn.type = 'button';
                    addFolderBtn.className = 'btn btn-xs btn-ghost';
                    addFolderBtn.style.cssText = 'display:flex;justify-content:flex-start;padding:6px 8px;border-radius:7px;';
                    addFolderBtn.textContent = '+ Nueva carpeta...';
                    addFolderBtn.addEventListener('click', async () => {
                        const newName = prompt('Nombre de la nueva carpeta:');
                        const newId = await createFolderFromInline(newName);
                        if (!newId) return;
                        const next = [...getProjectFolderIds(p.id), newId];
                        setProjectFolderIds(p.id, next);
                        queueFolderStateSave();
                        renderOwnedWithFolders();
                    });

                    pickerBox.appendChild(addFolderBtn);
                    folderPickerWrap.appendChild(pickerBox);
                    info.appendChild(folderPickerWrap);
                }

                // Share btn — opens share modal for this specific project
                const shareBtn = document.createElement('button');
                shareBtn.className = 'btn btn-xs btn-ghost project-share-btn';
                shareBtn.innerHTML = actionIcons.share;
                shareBtn.title = 'Compartir';
                shareBtn.addEventListener('click', () => {
                    _pendingShareProjectId = p.id;
                    _pendingShareUrlBase = FirebaseData.getShareUrl(p.id);
                    UI.hideModal('modal-projects');
                    UI.showModal('modal-share-options');
                });

                // Duplicate btn
                const dupBtn = document.createElement('button');
                dupBtn.className = 'btn btn-xs btn-ghost project-dup-btn';
                dupBtn.innerHTML = actionIcons.duplicate;
                dupBtn.title = 'Duplicar proyecto';
                dupBtn.addEventListener('click', async () => {
                    UI.toast('Duplicando...', '');
                    try {
                        const data = await FirebaseData.loadProject(p.id);
                        if (!data) { UI.toast('Error al duplicar', 'error'); return; }
                        data.title = (data.title || 'Proyecto') + ' (copia)';
                        const newId = await FirebaseData.saveProject(null, data);
                        FirebaseData.addProjectLocally(newId, false);
                        UI.toast('Proyecto duplicado ✅', 'success');
                        // Re-open projects modal to show new copy
                        listOwned.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:16px;">Cargando...</p>';
                        const projects2 = await FirebaseData.listProjects(currentUser?.uid);
                        ownedProjectsCache = sortAlpha(projects2.filter(x => !x.isShared), 'title');
                        renderOwnedWithFolders();
                        const refreshedSharedProjects = projects2.filter(x => x.isShared);
                        sharedProjectsCount = refreshedSharedProjects.length;
                        renderList(listShared, refreshedSharedProjects);
                        updateSharedSectionUI();
                    } catch(e) {
                        UI.toast('Error al duplicar', 'error');
                    }
                });

                // Rename btn
                const renameBtn = document.createElement('button');
                renameBtn.className = 'btn btn-xs btn-ghost project-rename-btn';
                renameBtn.innerHTML = actionIcons.rename;
                renameBtn.title = 'Renombrar proyecto';
                renameBtn.addEventListener('click', async () => {
                    const newName = prompt('Nuevo nombre del proyecto:', p.title);
                    if (!newName || !newName.trim() || newName.trim() === p.title) return;
                    try {
                        const data = await FirebaseData.loadProject(p.id);
                        if (!data) { UI.toast('Error al renombrar', 'error'); return; }
                        data.title = newName.trim();
                        await FirebaseData.saveProject(p.id, data);
                        p.title = newName.trim();
                        info.querySelector('.project-title').textContent = p.title;
                        UI.toast('Proyecto renombrado ✅', 'success');
                    } catch(e) {
                        UI.toast('Error al renombrar', 'error');
                    }
                });

                // Open btn
                const loadBtn = document.createElement('button');
                loadBtn.className = 'btn btn-xs btn-ghost project-load-btn';
                loadBtn.innerHTML = p.isShared ? actionIcons.view : actionIcons.open;
                loadBtn.title = 'Abrir proyecto';
                const openProject = async () => {
                    UI.hideModal('modal-projects');

                    if (p.isShared) {
                        window.location.href = FirebaseData.getShareUrl(p.id) + '&mode=view';
                        return;
                    }

                    UI.toast('Cargando proyecto...', '');
                    const loaded = await AppState.loadFromCloud(p.id);
                    if (loaded) {
                        await Promise.all([
                            FirebaseData.markProjectOpened(p.id),
                            rememberLastProject(p.id),
                        ]);
                        FirebaseData.addProjectLocally(p.id, false);
                        UI.toast('Proyecto cargado ✅', 'success');
                        UI.refreshAll();
                        const game = AppState.getCurrentGame();
                        if (game) {
                            if (game.local_video_url) {
                                YTPlayer.loadLocalVideo(game.local_video_url);
                            } else if (game.youtube_video_id) {
                                YTPlayer.loadVideo(game.youtube_video_id);
                            }
                        }
                        const url = FirebaseData.getShareUrl(p.id);
                        window.history.replaceState({}, '', url);
                    } else {
                        UI.toast('Error al cargar', 'error');
                    }
                };
                loadBtn.addEventListener('click', openProject);
                info.addEventListener('dblclick', openProject);

                // Delete btn
                const delBtn = document.createElement('button');
                delBtn.className = 'btn btn-xs btn-danger project-delete-btn';
                delBtn.innerHTML = actionIcons.delete;
                delBtn.title = p.isShared ? 'Remover de la lista' : 'Quitar local o borrar de nube';
                delBtn.addEventListener('click', async () => {
                    if (p.isShared) {
                        if (confirm(`¿Quitar "${p.title}" de tu lista local?`)) {
                            FirebaseData.removeProjectLocally(p.id);
                            el.remove();
                        }
                        return;
                    }

                    const choice = prompt(
                        `¿Qué querés hacer con "${p.title}"?\n\n` +
                        `1 = Quitar solo de mi lista local\n` +
                        `2 = Eliminar definitivamente de la nube\n\n` +
                        `Escribí 1 o 2`
                    );
                    if (!choice) return;

                    if (choice.trim() === '1') {
                        FirebaseData.removeProjectLocally(p.id);
                        el.remove();
                        UI.toast('Proyecto quitado de tu lista local.', 'success');
                        return;
                    }
                    if (choice.trim() !== '2') {
                        UI.toast('Opción inválida. Escribí 1 o 2.', 'error');
                        return;
                    }

                    const confirmCloudDelete = confirm(
                        `⚠️ Vas a eliminar "${p.title}" de la nube.\n\n` +
                        `Esto borra el proyecto de Firestore y no se puede deshacer.\n\n` +
                        `¿Confirmar eliminación definitiva?`
                    );
                    if (!confirmCloudDelete) return;

                    try {
                        await FirebaseData.deleteProjectCloud(p.id);
                        el.remove();
                        UI.toast('Proyecto eliminado definitivamente de la nube.', 'success');
                    } catch (err) {
                        console.error('deleteProjectCloud error:', err);
                        UI.toast(`No se pudo eliminar de la nube: ${err.message || err}`, 'error');
                    }
                });

                if (withFolders && canUseFolders) {
                    const moveBtn = document.createElement('button');
                    moveBtn.className = 'btn btn-xs btn-ghost project-move-btn';
                    moveBtn.innerHTML = actionIcons.move;
                    moveBtn.title = 'Mover a carpeta';
                    moveBtn.addEventListener('click', async () => {
                        document.querySelectorAll('.project-folder-picker-wrap').forEach((el2) => {
                            if (el2 !== info.querySelector('.project-folder-picker-wrap')) el2.style.display = 'none';
                        });
                        const pickerWrap = info.querySelector('.project-folder-picker-wrap');
                        if (pickerWrap) {
                            const isOpen = pickerWrap.style.display !== 'none';
                            pickerWrap.style.display = isOpen ? 'none' : 'block';
                            if (!isOpen) {
                                const rowRect = el.getBoundingClientRect();
                                const listRect = listOwned.getBoundingClientRect();
                                const pickerBoxEl = pickerWrap.querySelector('.project-folder-picker-box');
                                const estimatedMenuHeight = 190;
                                const spaceBelow = listRect.bottom - rowRect.bottom;
                                const spaceAbove = rowRect.top - listRect.top;
                                if (spaceBelow < estimatedMenuHeight) {
                                    if (spaceAbove > spaceBelow) {
                                        pickerWrap.style.top = 'auto';
                                        pickerWrap.style.bottom = 'calc(100% + 6px)';
                                        if (pickerBoxEl) {
                                            const h = Math.max(120, Math.floor(spaceAbove - 12));
                                            pickerBoxEl.style.maxHeight = `${h}px`;
                                        }
                                    } else {
                                        pickerWrap.style.top = 'calc(100% + 6px)';
                                        pickerWrap.style.bottom = 'auto';
                                        if (pickerBoxEl) {
                                            const h = Math.max(120, Math.floor(spaceBelow - 12));
                                            pickerBoxEl.style.maxHeight = `${h}px`;
                                        }
                                    }
                                } else {
                                    pickerWrap.style.top = 'calc(100% + 6px)';
                                    pickerWrap.style.bottom = 'auto';
                                    if (pickerBoxEl) pickerBoxEl.style.maxHeight = '180px';
                                }
                                const picker = pickerWrap.querySelector('button');
                                if (picker && typeof picker.focus === 'function') picker.focus();
                            }
                        }
                    });
                    actions.appendChild(moveBtn);
                }

                if (hasShareFeature) actions.appendChild(shareBtn);
                actions.appendChild(dupBtn);
                actions.appendChild(renameBtn);
                actions.appendChild(loadBtn);
                actions.appendChild(delBtn);

                el.appendChild(info);
                el.appendChild(actions);
                return el;
            };

            if (!withFolders) {
                arr.forEach((p) => container.appendChild(renderProjectRow(p)));
                return;
            }

            // Group by folder (visual-only user organization)
            const folderById = {};
            folderState.folders.forEach((f) => { folderById[f.id] = f; });
            const groups = new Map();
            const needle = normalizeText(projectSearchQuery);
            const filtered = !needle
                ? arr
                : arr.filter((p) => normalizeText(p?.title).includes(needle));

            if (!filtered.length) {
                container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:16px;">No hay proyectos para esa búsqueda</p>';
                return;
            }

            const recentRows = filtered
                .slice()
                .sort((a, b) => getUpdatedMs(b) - getUpdatedMs(a))
                .slice(0, 8);

            const renderRecentSection = () => {
                if (!recentRows.length) {
                    if (activeFolderFilterId === RECENT_FILTER_KEY) {
                        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:16px;">No hay recientes</p>';
                        return true;
                    }
                    return false;
                }
                const isCollapsed = collapsedFolderKeys.has(RECENT_FILTER_KEY);
                const recentTitle = document.createElement('div');
                recentTitle.className = 'project-group-title project-group-title--clickable';
                recentTitle.innerHTML = `<span>${isCollapsed ? '▸' : '▾'} Recientes</span><span class="project-group-count">${recentRows.length}</span>`;
                recentTitle.addEventListener('click', () => {
                    if (collapsedFolderKeys.has(RECENT_FILTER_KEY)) collapsedFolderKeys.delete(RECENT_FILTER_KEY);
                    else collapsedFolderKeys.add(RECENT_FILTER_KEY);
                    renderOwnedWithFolders();
                });
                container.appendChild(recentTitle);
                if (!isCollapsed) {
                    recentRows.forEach((p) => container.appendChild(renderProjectRow(p)));
                }
                return true;
            };

            if (activeFolderFilterId === RECENT_FILTER_KEY) {
                renderRecentSection();
                return;
            }

            if (!activeFolderFilterId) {
                renderRecentSection();
            }

            filtered.forEach((p) => {
                const ids = getProjectFolderIds(p.id);
                if (!ids.length) {
                    if (!groups.has('__none__')) groups.set('__none__', []);
                    groups.get('__none__').push(p);
                    return;
                }
                ids.forEach((key) => {
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key).push(p);
                });
            });

            let groupKeys = Array.from(groups.keys()).sort((a, b) => {
                if (a === '__none__') return -1;
                if (b === '__none__') return 1;
                return String(folderById[a]?.name || '').localeCompare(String(folderById[b]?.name || ''), 'es', { sensitivity: 'base', numeric: true });
            });

            if (activeFolderFilterId) {
                groupKeys = groupKeys.filter((k) => k === activeFolderFilterId);
            }

            if (!folderCollapseInitialized) {
                groupKeys.forEach((k) => collapsedFolderKeys.add(k));
                folderCollapseInitialized = true;
            }

            if (!groupKeys.length) {
                container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:16px;">No hay proyectos en esa carpeta</p>';
                return;
            }

            groupKeys.forEach((key) => {
                const title = document.createElement('div');
                title.className = 'project-group-title project-group-title--clickable';
                const rowsInGroup = groups.get(key) || [];
                const isCollapsed = collapsedFolderKeys.has(key);
                title.innerHTML = `<span>${isCollapsed ? '▸' : '▾'} ${key === '__none__' ? 'Sin carpeta' : (folderById[key]?.name || 'Carpeta')}</span><span class="project-group-count">${rowsInGroup.length}</span>`;
                title.addEventListener('click', () => {
                    if (collapsedFolderKeys.has(key)) collapsedFolderKeys.delete(key);
                    else collapsedFolderKeys.add(key);
                    renderOwnedWithFolders();
                });
                container.appendChild(title);

                if (isCollapsed) return;
                const rows = sortAlpha(rowsInGroup, 'title');
                rows.forEach((p) => container.appendChild(renderProjectRow(p)));
            });
        };

        const renderOwnedWithFolders = () => {
            if (foldersSummary) {
                const folders = sortedFolders();
                const chip = (id, label, active = false) => `<button type="button" class="project-folder-chip${active ? ' is-active' : ''}" data-folder-chip="${id}" style="display:inline-flex;align-items:center;gap:4px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:999px;padding:2px 8px;margin:0 6px 6px 0;font-size:.72rem;color:${active ? 'var(--text)' : 'var(--text-muted)'};background:${active ? 'var(--accent-glow)' : 'transparent'};cursor:pointer;">${label}</button>`;
                foldersSummary.innerHTML = [
                    chip('', 'Todos', !activeFolderFilterId),
                    chip(RECENT_FILTER_KEY, 'Recientes', activeFolderFilterId === RECENT_FILTER_KEY),
                    chip(NO_FOLDER_FILTER_KEY, 'Sin carpeta', activeFolderFilterId === NO_FOLDER_FILTER_KEY),
                    ...folders.map((f) => chip(f.id, f.name, activeFolderFilterId === f.id)),
                ].join('');
                foldersSummary.querySelectorAll('[data-folder-chip]').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const id = btn.getAttribute('data-folder-chip') || '';
                        setActiveFolderFilter(id);
                    });
                });
            }
            renderFolderAdminPanel();
            renderList(listOwned, ownedProjectsCache, { withFolders: true });
        };

        try {
            ensureProjectsSearchUI();
            const projects = await FirebaseData.listProjects(currentUser?.uid);
            if (canUseFolders) {
                folderState = await FirebaseData.loadUserProjectFolders(folderUserId);
            } else {
                folderState = { folders: [], projectMap: {} };
            }
            const ownedProjects = projects.filter(p => !p.isShared);
            const sharedProjects = projects.filter(p => p.isShared);
            ownedProjectsCache = sortAlpha(ownedProjects, 'title');
            renderOwnedWithFolders();
            if (hasShareFeature) {
                sharedProjectsCount = sharedProjects.length;
                renderList(listShared, sharedProjects);
                updateSharedSectionUI();
            }
        } catch (err) {
            console.error('[openProjectsModal] error:', err);
            listOwned.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px;">Error al conectar.</p>';
            if (listShared) {
                listShared.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px;">Error al conectar.</p>';
            }
        }
    }

    $('#btn-my-projects').addEventListener('click', openProjectsModal);
    $('#btn-open-projects-header')?.addEventListener('click', openProjectsModal);

    $('#btn-close-projects').addEventListener('click', () => {
        UI.hideModal('modal-projects');
    });

    // ── Modal tabs (Proyectos / Colecciones) ──
    document.querySelectorAll('[data-modal-tab]').forEach(tab => {
        tab.addEventListener('click', async () => {
            document.querySelectorAll('[data-modal-tab]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const which = tab.dataset.modalTab;
            $('#modal-tab-projects').style.display = which === 'projects' ? '' : 'none';
            $('#modal-tab-collections').style.display = which === 'collections' ? '' : 'none';
            if (which === 'collections') await _loadAndRenderCollections();
        });
    });

    async function _loadAndRenderCollections() {
        const uid = AppState.get('userId');
        if (!uid || uid === 'anonymous') {
            UI.renderCollectionsTab([]);
            return;
        }
        const list = $('#collection-list');
        if (list) list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px;">Cargando...</p>';
        const cols = await FirebaseData.listUserCollections(uid);
        UI.renderCollectionsTab(cols);
        _wireCollectionTabButtons();
    }

    function _wireCollectionTabButtons() {
        $('#collection-list')?.querySelectorAll('.col-open-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const colId = btn.dataset.colId;
                UI.hideModal('modal-projects');
                const data = await FirebaseData.loadCollection(colId);
                if (!data) { UI.toast('No se pudo cargar la colección', 'error'); return; }
                AppState.openCollection(data);
            });
        });
        $('#collection-list')?.querySelectorAll('.col-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const { colId, colName } = btn.dataset;
                if (!confirm(`¿Eliminar la colección "${colName}"?\nEsta acción no se puede deshacer.`)) return;
                await FirebaseData.deleteCollectionDoc(colId);
                UI.toast('Colección eliminada', 'success');
                await _loadAndRenderCollections();
            });
        });
    }

    // Create collection from modal tab
    $('#btn-create-collection')?.addEventListener('click', async () => {
        const input = $('#new-collection-name');
        const name = (input?.value || '').trim();
        if (!name) { UI.toast('Ingresá un nombre', 'error'); return; }
        const uid = AppState.get('userId');
        await FirebaseData.saveCollection(null, { name, ownerUid: uid === 'anonymous' ? null : uid, items: [] });
        if (input) input.value = '';
        UI.toast(`Colección "${name}" creada`, 'success');
        await _loadAndRenderCollections();
    });
    $('#new-collection-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-create-collection')?.click(); });

    // ── Active collection bar ──
    $('#btn-collection-close')?.addEventListener('click', () => {
        AppState.closeCollection();
    });

    $('#btn-collection-rename')?.addEventListener('click', async () => {
        const col = AppState.get('activeCollection');
        if (!col) return;
        const name = prompt('Nuevo nombre:', col.name);
        if (!name?.trim()) return;
        const updated = { ...col, name: name.trim() };
        await FirebaseData.saveCollection(col.id, updated);
        AppState.openCollection(updated, { clearProject: false });
        UI.toast('Colección renombrada', 'success');
    });

    $('#btn-collection-delete')?.addEventListener('click', async () => {
        const col = AppState.get('activeCollection');
        if (!col) return;
        if (!confirm(`¿Eliminar la colección "${col.name}"?\nEsta acción no se puede deshacer.`)) return;
        await FirebaseData.deleteCollectionDoc(col.id);
        AppState.closeCollection();
        UI.toast('Colección eliminada', 'success');
    });

    // ── Enviar playlist a colección ──
    let _exportTargetPlaylistId = null;

    $('#btn-pl-to-collection')?.addEventListener('click', async () => {
        const playlistId = AppState.get('activePlaylistId');
        if (!playlistId) return;
        const pl = (AppState.get('playlists') || []).find(p => p.id === playlistId);
        _exportTargetPlaylistId = playlistId;
        const nameEl = $('#export-collection-playlist-name');
        if (nameEl) nameEl.textContent = `Playlist: ${pl ? pl.name : playlistId}`;
        // Load user collections for the picker
        const uid = AppState.get('userId');
        const cols = uid && uid !== 'anonymous' ? await FirebaseData.listUserCollections(uid) : [];
        UI.renderExportCollectionList(cols);
        _wireExportCollectionPicker();
        UI.showModal('modal-export-collection');
    });

    function _buildSnapshotItems(playlistId) {
        const playlistItems = AppState.get('playlistItems')[playlistId] || [];
        const clips = AppState.get('clips');
        const clipFlags = AppState.get('clipFlags');
        const game = AppState.getCurrentGame();
        const pl = (AppState.get('playlists') || []).find(p => p.id === playlistId);

        return playlistItems.map(clipId => {
            const clip = clips.find(c => c.id === clipId);
            if (!clip) return null;
            const tag = AppState.getTagType(clip.tag_type_id);
            const comments = AppState.getComments(playlistId, clipId);
            return {
                id: 'ci_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                sourceProjectId: AppState.get('currentProjectId') || '',
                sourceProjectTitle: game ? (game.title || 'Partido') : 'Partido',
                sourcePlaylistId: playlistId,
                sourcePlaylistName: pl ? pl.name : '',
                youtubeVideoId: game ? (game.youtube_video_id || '') : '',
                tagLabel: tag ? tag.label : 'Clip',
                startSec: clip.start_sec,
                endSec: clip.end_sec,
                t_sec: clip.t_sec,
                flags: [...(clipFlags[clipId] || [])],
                comments: [...comments],
            };
        }).filter(Boolean);
    }

    async function _exportPlaylistToCollection(colId, colName) {
        const newItems = _buildSnapshotItems(_exportTargetPlaylistId);
        if (!newItems.length) { UI.toast('La playlist no tiene clips', 'error'); return; }
        const existing = await FirebaseData.loadCollection(colId);
        const merged = { ...existing, items: [...(existing?.items || []), ...newItems] };
        await FirebaseData.saveCollection(colId, merged);
        UI.hideModal('modal-export-collection');
        UI.toast(`${newItems.length} clips enviados a "${colName}" ✅`, 'success');
    }

    function _wireExportCollectionPicker() {
        $('#export-collection-list')?.querySelectorAll('[data-col-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                _exportPlaylistToCollection(btn.dataset.colId, btn.dataset.colName);
            });
        });
    }

    $('#btn-export-create-collection')?.addEventListener('click', async () => {
        const input = $('#export-new-collection-name');
        const name = (input?.value || '').trim();
        if (!name) { UI.toast('Ingresá un nombre para la colección', 'error'); return; }
        const uid = AppState.get('userId');
        const colId = await FirebaseData.saveCollection(null, { name, ownerUid: uid === 'anonymous' ? null : uid, items: [] });
        if (input) input.value = '';
        await _exportPlaylistToCollection(colId, name);
    });
    $('#export-new-collection-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-export-create-collection')?.click(); });

    $('#btn-cancel-export-collection')?.addEventListener('click', () => {
        UI.hideModal('modal-export-collection');
    });

    // Focus view toggle
    const btnFocusView = $('#btn-focus-view');
    if (btnFocusView) {
        btnFocusView.addEventListener('click', () => {
            AppState.toggleFocusView();
        });
    }

    // Nav arrows
    $('#btn-prev-clip').addEventListener('click', () => {
        navigateToClipAndPlay('prev');
    });

    $('#btn-next-clip').addEventListener('click', () => {
        navigateToClipAndPlay('next');
    });

    // ═══════════════════════════════════════
    // KEYBOARD SHORTCUTS
    // ═══════════════════════════════════════

    // Mouse clicks should not leave buttons focused (prevents Space re-triggering
    // the last clicked action button, e.g. flags).
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        // detail > 0 => pointer-generated click (mouse/touch), keyboard clicks are usually 0.
        if (e.detail > 0) {
            setTimeout(() => {
                if (document.activeElement === btn) btn.blur();
            }, 0);
        }
    });

    document.addEventListener('keydown', (e) => {
        const bbModal = $('#modal-buttonboards');
        const isBBModalOpen = !!(bbModal && !bbModal.classList.contains('hidden'));
        const prefModal = $('#modal-preferences');
        const isPrefModalOpen = !!(prefModal && !prefModal.classList.contains('hidden'));

        // Open quick last-clip menu (Analyze): Cmd/Ctrl + Shift + M
        if (!isBBModalOpen && !isPrefModalOpen && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
            e.preventDefault();
            e.stopPropagation();
            if (_quickClipMenuOpen) closeQuickClipMenu();
            else openQuickClipMenu();
            return;
        }

        // While quick menu is open, don't let background shortcuts create clips.
        if (_quickClipMenuOpen) {
            const key = (e.key || '').toLowerCase();
            if (e.key === 'Escape') {
                e.preventDefault();
                if (_quickPlaylistPickerOpen) {
                    toggleQuickPlaylistPicker(false);
                    return;
                }
                closeQuickClipMenu();
                return;
            }
            if (_quickPlaylistPickerOpen) {
                if (key >= '1' && key <= '9') {
                    e.preventDefault();
                    const idx = Number(key) - 1;
                    const playlists = getQuickPlaylists();
                    const pl = playlists[idx];
                    if (pl) addCurrentQuickClipToPlaylist(pl.id);
                    return;
                }
                if (key === 'n') {
                    e.preventDefault();
                    const input = $('#quick-playlist-new-name');
                    if (document.activeElement !== input) input?.focus();
                    else createQuickPlaylistAndSend();
                    return;
                }
            }
            if (QUICK_KEYS.includes(key)) {
                e.preventDefault();
                quickActionByKey(key);
                return;
            }
            e.preventDefault();
            return;
        }

        // Escape en el modal de ventanas de código: confirmar si hay cambios (también con foco en inputs del editor)
        if (e.key === 'Escape') {
            if (isBBModalOpen) {
                e.preventDefault();
                if (!_bbHideButtonboardsModal()) return;
                if (AppState.get('focusView')) {
                    AppState.toggleFocusView();
                }
                return;
            }
        }
        if (e.key === 'Escape' && AppState.get('mode') === 'analyze' && typeof AppState.cancelOpenManualClips === 'function') {
            const cancelled = AppState.cancelOpenManualClips();
            if (cancelled > 0) {
                e.preventDefault();
                UI.toast(`${cancelled} evento${cancelled > 1 ? 's' : ''} manual${cancelled > 1 ? 'es' : ''} cancelado${cancelled > 1 ? 's' : ''}`, 'info');
                if (typeof UI.renderTagButtons === 'function') UI.renderTagButtons();
                return;
            }
        }
        // Mientras el editor/modal de ventanas de código está abierto, no ejecutar atajos globales.
        if (isBBModalOpen) return;

        // Don't handle shortcuts when typing in inputs
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        // Avoid double-toggle: when a button/control has focus, Space may trigger native click.
        if (matchesShortcut(e, 'playPause') && e.target && typeof e.target.closest === 'function') {
            if (e.target.closest('button, a, [role="button"], summary, video')) return;
        }

        // Play/Pause shortcut
        if (matchesShortcut(e, 'playPause')) {
            e.preventDefault();
            // If drawing overlays are visible: dismiss them and resume instead of toggling
            if (typeof DrawingTool !== 'undefined' && DrawingTool.hasPlaybackOverlays()) {
                DrawingTool.dismissPlaybackOverlays();
                YTPlayer.play();
            } else if (typeof YTPlayer !== 'undefined' && YTPlayer.togglePlay) {
                YTPlayer.togglePlay();
            }
            return;
        }

        const mode = AppState.get('mode');

        // Arrow keys: seek video (Analyze mode)
        if (mode === 'analyze') {
            if (matchesShortcut(e, 'seekLeft') || matchesShortcut(e, 'seekLeftFast')) {
                e.preventDefault();
                const t = YTPlayer.getCurrentTime();
                const step = matchesShortcut(e, 'seekLeftFast') ? getSeekStep(true) : getSeekStep(false);
                YTPlayer.seekTo(Math.max(0, t - step));
                showPlayerSeekFeedback(-1, step);
                return;
            }
            if (matchesShortcut(e, 'seekRight') || matchesShortcut(e, 'seekRightFast')) {
                e.preventDefault();
                const t = YTPlayer.getCurrentTime();
                const step = matchesShortcut(e, 'seekRightFast') ? getSeekStep(true) : getSeekStep(false);
                YTPlayer.seekTo(t + step);
                showPlayerSeekFeedback(1, step);
                return;
            }

            // Check for tag hotkeys
            const activeKey = e.key.toLowerCase();
            const tagBtn = document.querySelector(`.tag-btn[data-hotkey="${activeKey}"]`);
            if (tagBtn) {
                e.preventDefault();
                tagBtn.click();
                return;
            }
        }

        // Arrow keys: navigate clips (View mode). Flechas solas = clip anterior/siguiente;
        // Shift+flecha (u otros atajos de seekLeftFast/seekRightFast) = salto de tiempo como en Análisis.
        if (mode === 'view') {
            if (matchesShortcut(e, 'seekLeftFast')) {
                e.preventDefault();
                const t = YTPlayer.getCurrentTime();
                const step = getSeekStep(true);
                YTPlayer.seekTo(Math.max(0, t - step));
                showPlayerSeekFeedback(-1, step);
                return;
            }
            if (matchesShortcut(e, 'seekRightFast')) {
                e.preventDefault();
                const t = YTPlayer.getCurrentTime();
                const step = getSeekStep(true);
                YTPlayer.seekTo(t + step);
                showPlayerSeekFeedback(1, step);
                return;
            }
            if (e.key === 'ArrowLeft' && !e.shiftKey) {
                e.preventDefault();
                navigateToClipAndPlay('prev');
                return;
            }
            if (e.key === 'ArrowRight' && !e.shiftKey) {
                e.preventDefault();
                navigateToClipAndPlay('next');
                return;
            }

            // Number keys 1-4: toggle flags
            const clip = AppState.getCurrentClip();
            if (clip) {
                const flagMap = { '1': 'bueno', '2': 'acorregir', '3': 'duda', '4': 'importante' };
                if (flagMap[e.key]) {
                    e.preventDefault();
                    const flag = flagMap[e.key];
                    AppState.toggleFlag(clip.id, flag);
                    const flags = AppState.getClipUserFlags(clip.id);
                    const emoji = UI.FLAG_EMOJI[flag];
                    const has = flags.includes(flag);
                    UI.toast(`${emoji} ${has ? 'agregado' : 'quitado'}`, has ? 'success' : '');
                    return;
                }
            }
        }

        // Escape: close modals or exit focus (modal-buttonboards ya se manejó arriba)
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
            if (AppState.get('focusView')) {
                AppState.toggleFocusView();
            }
        }

        // F key: toggle focus view (View mode)
        if (e.key === 'f' && mode === 'view') {
            e.preventDefault();
            AppState.toggleFocusView();
        }

        // Space: play/pause handled by YouTube player naturally
    });

    /**
     * Con `<video>` enfocado (archivo local / WebM tras captura), el navegador aplica seek nativo
     * con flechas sin modificadores — compite con «salto normal» (p. ej. 5 s) en Analizar y con
     * anterior/siguiente clip en Ver. Shift+flecha no suele tener ese default, por eso el salto
     * rápido parecía funcionar y el normal no. Evitamos el default en fase capture.
     */
    document.addEventListener(
        'keydown',
        (e) => {
            const mode = AppState.get('mode');
            if (mode !== 'analyze' && mode !== 'view') return;
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
            if (!e.target?.closest?.('video')) return;
            e.preventDefault();
        },
        true
    );

    // ═══ FLAG FILTER BAR ═══
    document.querySelectorAll('#flag-filter-bar .flag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.toggleFilterFlag(btn.dataset.flag);
        });
    });

    // Clear flag filter
    const btnClearFlagFilter = $('#btn-clear-flag-filter');
    if (btnClearFlagFilter) {
        btnClearFlagFilter.addEventListener('click', () => {
            AppState.clearFilterFlags();
        });
    }

    // Reset all filters
    const btnResetAll = $('#btn-reset-all-filters');
    if (btnResetAll) {
        btnResetAll.addEventListener('click', () => {
            const urlParams = new URLSearchParams(window.location.search);
            const isReadOnly = urlParams.get('mode') === 'view';
            const sharedPlaylistId = urlParams.get('playlist');
            const isLockedPlaylist = isReadOnly && sharedPlaylistId && AppState.get('activePlaylistId') === sharedPlaylistId;

            if (isLockedPlaylist) {
                AppState.clearTagFilters();
                AppState.clearFilterFlags();
                UI.toast('Se limpiaron los tags. La playlist compartida se mantiene.', 'info');
            } else {
                AppState.clearAllFilters();
            }
        });
    }

    // ═══ TAG EDITOR ═══
    $('#btn-toggle-tag-editor').addEventListener('click', () => {
        UI.toggleTagEditor();
    });

    $('#btn-save-tag').addEventListener('click', () => {
        UI.saveTagFromEditor();
    });

    $('#btn-delete-tag').addEventListener('click', () => {
        UI.deleteTagFromEditor();
    });

    $('#btn-cancel-tag-edit').addEventListener('click', () => {
        UI.closeTagInlineEditor();
    });

    // Cancel add-to-playlist modal
    $('#btn-cancel-add-playlist').addEventListener('click', () => {
        UI.hideModal('modal-add-to-playlist');
    });

    // ═══════════════════════════════════════
    // XML IMPORT / EXPORT
    // ═══════════════════════════════════════

    const btnExportXml = $('#btn-export-xml');
    if (btnExportXml) {
        btnExportXml.addEventListener('click', () => {
            if (!AppState.hasFeature(FEATURES.EXPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const xml = AppState.exportXML();
            if (!xml) {
                UI.toast('No hay datos para exportar o no seleccionaste un partido', 'error');
                return;
            }

            const game = AppState.getCurrentGame();
            const title = game && game.title ? game.title : 'proyecto';
            const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_SportCode.xml`;

            ExportManager.download(xml, filename);
        });
    }

    const btnImportXml = $('#btn-import-xml');
    const inputImportXml = $('#input-import-xml');
    if (btnImportXml && inputImportXml) {
        btnImportXml.addEventListener('click', () => {
            if (!AppState.hasFeature(FEATURES.IMPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            if (!AppState.get('currentGameId')) {
                UI.toast('Primero creá o seleccioná un partido vacío adonde importar', 'error');
                return;
            }
            inputImportXml.click();
        });

        inputImportXml.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (ev) => {
                const xmlString = ev.target.result;
                let offset = 0;

                try {
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(xmlString, "application/xml");
                    
                    // Find first "Start" in XML
                    let xmlStartSec = null;
                    const instances = xmlDoc.querySelectorAll("ALL_INSTANCES > instance");
                    for (const inst of instances) {
                        const code = inst.querySelector("code")?.textContent?.trim();
                        if (code === "Start") {
                            xmlStartSec = parseFloat(inst.querySelector("start")?.textContent || 0);
                            break;
                        }
                    }

                    // Find "Start" in AppState
                    const appStartClip = AppState.get('clips').find(c => {
                        const tag = AppState.getTagType(c.tag_type_id);
                        return tag && tag.id === 'tag-start';
                    });

                    if (xmlStartSec !== null) {
                        if (appStartClip) {
                            // CASE: Both exist -> Alignment
                            offset = appStartClip.t_sec - xmlStartSec;
                        } else {
                            // CASE: XML has Start, but App doesn't
                            const choice = confirm("El XML tiene un evento 'Start' pero el proyecto actual NO tiene uno.\n\n¿Deseas importar igualmente sin alineación (inicio en 0)?\n\n(Aceptar = Importar en 0 / Cancelar = Detener para crear el 'Start')");
                            if (!choice) return; // Stop to let user create Start
                            offset = 0;
                        }
                    } else {
                        // CASE: XML doesn't have Start
                        const choice = confirm("El XML NO tiene evento 'Start'. No se podrá alinear de forma automática.\n\n¿Deseas importar igualmente sin alineación (inicio en 0)?");
                        if (!choice) return; // Stop the import
                        offset = 0;
                    }

                } catch (e) {
                    console.error("Error pre-parsing XML for alignment:", e);
                }

                const res = AppState.importXML(xmlString, offset);
                if (res !== false) {
                    const offsetMsg = offset !== 0 ? ` (Alineado: ${offset.toFixed(2)}s)` : "";
                    UI.toast(`¡Importado! ${res} clips agregados${offsetMsg}`, 'success');
                } else {
                    UI.toast('Error al leer el XML', 'error');
                }
            };
            reader.readAsText(file);
            inputImportXml.value = ''; // reset so we can upload same file again
        });
    }

    // ═══════════════════════════════════════
    // SAVE / SHARE
    // ═══════════════════════════════════════

    $('#btn-save-project').addEventListener('click', async () => {
        const btn = $('#btn-save-project');

        // Before saving the first time, if we have custom games + the demo game, let's remove the demo game
        const hasCustomGames = AppState.get('games').some(g => g.id !== 'game-demo-1');
        if (hasCustomGames) {
            const demoIdx = AppState.get('games').findIndex(g => g.id === 'game-demo-1');
            if (demoIdx >= 0) {
                // If demo game exists, we remove it from the state
                AppState.get('games').splice(demoIdx, 1);
            }
        }

        setSaveButtonState('saving');
        try {
            const projectId = await AppState.saveToCloud();
            FirebaseData.addProjectLocally(projectId);
            UI.toast('Proyecto guardado ✅', 'success');

            // First save nudge: offer enabling autosave so user doesn't forget future saves.
            if (!isAutoSaveEnabled() && !_autoSaveNudgeShown) {
                const wantsAutoSave = confirm('Proyecto guardado ✅\n\n¿Querés activar Auto-guardar cada 60 segundos para este proyecto?');
                _autoSaveNudgeShown = true;
                if (wantsAutoSave) {
                    setAutoSaveEnabled(true);
                    UI.toast('Auto-guardado activado (60s) ✅', 'success');
                }
            }
        } catch (err) {
            console.error('Save error:', err);
            UI.toast('Error al guardar: ' + err.message, 'error');
            setSaveButtonState();
        } finally {
            if (btn.classList.contains('is-saving')) setSaveButtonState();
        }
    });

    // Share Project Modal logic
    let _pendingShareUrlBase = '';
    let _pendingShareProjectId = null;

    $('#btn-share-edit').addEventListener('click', () => {
        UI.hideModal('modal-share-options');
        const url = _pendingShareUrlBase;
        navigator.clipboard.writeText(url).then(() => {
            UI.toast('🔗 Link (Edición) copiado', 'success');
        }).catch(() => {
            prompt('Copiá este link:', url);
        });
    });

    $('#btn-share-view').addEventListener('click', () => {
        UI.hideModal('modal-share-options');
        const url = _pendingShareUrlBase + '&mode=view';
        navigator.clipboard.writeText(url).then(() => {
            UI.toast('🔗 Link (Solo Ver) copiado', 'success');
        }).catch(() => {
            prompt('Copiá este link:', url);
        });
    });

    // Export XML from share modal
    const btnShareExportXml = $('#btn-share-export-xml');
    if (btnShareExportXml) {
        btnShareExportXml.addEventListener('click', async () => {
            if (!AppState.hasFeature(FEATURES.EXPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            UI.hideModal('modal-share-options');
            let xml = null;
            if (_pendingShareProjectId && _pendingShareProjectId === AppState.get('currentProjectId')) {
                xml = AppState.exportXML();
            } else if (_pendingShareProjectId) {
                UI.toast('Preparando XML...', '');
                const data = await FirebaseData.loadProject(_pendingShareProjectId);
                if (data) {
                    xml = ExportManager.generateXML(data);
                }
            }

            if (xml) {
                const game = AppState.getCurrentGame();
                const title = game && game.title ? game.title : 'SimpleReplay';
                const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_SportCode.xml`;
                ExportManager.download(xml, filename);
            }
        });
    }

    // Export JSON from share modal
    const btnShareExportJson = $('#btn-share-export-json');
    if (btnShareExportJson) {
        btnShareExportJson.addEventListener('click', async () => {
            if (!AppState.hasFeature(FEATURES.EXPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            UI.hideModal('modal-share-options');
            const data = AppState.exportProjectData();
            if (data) {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `SimpleReplay_${data.game.title.replace(/\s+/g, '_')}.json`;
                a.click();
            } else {
                UI.toast('No hay un proyecto activo para exportar', 'error');
            }
        });
    }

    const btnSharePlaylistModal = $('#btn-share-playlist-modal');
    if (btnSharePlaylistModal) {
        btnSharePlaylistModal.addEventListener('click', () => {
            const plId = $('#share-playlist-select').value;
            if (!plId) return;
            UI.hideModal('modal-share-options');
            const url = _pendingShareUrlBase + '&playlist=' + plId + '&mode=view';
            navigator.clipboard.writeText(url).then(() => {
                UI.toast('🔗 Link de Playlist copiado', 'success');
            }).catch(() => {
                prompt('Copiá este link:', url);
            });
        });
    }

    $('#btn-cancel-share').addEventListener('click', () => {
        UI.hideModal('modal-share-options');
    });

    // ═══════════════════════════════════════
    // SHARE PANEL ACTIONS (sidebar panel)
    // ═══════════════════════════════════════

    function getShareUrls() {
        if (!AppState.hasFeature(FEATURES.SHARE)) {
            UI.toast(getProFeatureMessage(), 'info');
            return null;
        }
        const projectId = AppState.get('currentProjectId');
        const editKey = AppState.get('editKey');
        if (!projectId) return null;
        
        // Exclude gameId from project-level links so the app can automatically 
        // select the game with the most clips on initial load.
        const collabBase = FirebaseData.getShareUrl(projectId, null, null, editKey);
        const readonlyBase = FirebaseData.getShareUrl(projectId, null);
        const base = readonlyBase; // base without mode for playlist links
        return {
            collab: collabBase,
            readonly: readonlyBase + '&mode=view',
            base,
            projectId
        };
    }

    function openWhatsApp(url, text) {
        const msg = encodeURIComponent((text ? text + '\n' : '') + url);
        window.open('https://wa.me/?text=' + msg, '_blank');
    }

    // Copy icons
    const shareCopyCollab = $('#share-copy-collab');
    if (shareCopyCollab) {
        shareCopyCollab.addEventListener('click', (e) => {
            e.stopPropagation();
            const urls = getShareUrls();
            if (!urls) { UI.toast('Guardá el proyecto primero', 'error'); return; }
            navigator.clipboard.writeText(urls.collab).then(() => {
                UI.toast('🔗 Link colaborativo copiado', 'success');
            }).catch(() => prompt('Copiá este link:', urls.collab));
        });
    }

    const shareCopyReadonly = $('#share-copy-readonly');
    if (shareCopyReadonly) {
        shareCopyReadonly.addEventListener('click', (e) => {
            e.stopPropagation();
            const urls = getShareUrls();
            if (!urls) { UI.toast('Guardá el proyecto primero', 'error'); return; }
            navigator.clipboard.writeText(urls.readonly).then(() => {
                UI.toast('🔗 Link solo lectura copiado', 'success');
            }).catch(() => prompt('Copiá este link:', urls.readonly));
        });
    }

    // WhatsApp icons
    const shareWaCollab = $('#share-wa-collab');
    if (shareWaCollab) {
        shareWaCollab.addEventListener('click', (e) => {
            e.stopPropagation();
            const urls = getShareUrls();
            if (!urls) { UI.toast('Guardá el proyecto primero', 'error'); return; }
            openWhatsApp(urls.collab, 'Proyecto colaborativo SimpleReplay:');
        });
    }

    const shareWaReadonly = $('#share-wa-readonly');
    if (shareWaReadonly) {
        shareWaReadonly.addEventListener('click', (e) => {
            e.stopPropagation();
            const urls = getShareUrls();
            if (!urls) { UI.toast('Guardá el proyecto primero', 'error'); return; }
            openWhatsApp(urls.readonly, 'Análisis de partido (solo lectura):');
        });
    }

    // Playlist copy + WhatsApp
    const sharePanelPlaylistBtn = $('#share-btn-playlist');
    if (sharePanelPlaylistBtn) {
        sharePanelPlaylistBtn.addEventListener('click', () => {
            const urls = getShareUrls();
            if (!urls) { UI.toast('Guardá el proyecto primero', 'error'); return; }
            const sel = $('#share-panel-playlist-select');
            const plId = sel ? sel.value : '';
            if (!plId) { UI.toast('Seleccioná una playlist', 'error'); return; }
            const url = urls.base + '&playlist=' + plId + '&mode=view';
            navigator.clipboard.writeText(url).then(() => {
                UI.toast('🔗 Link de Playlist copiado', 'success');
            }).catch(() => prompt('Copiá este link:', url));
        });
    }

    const shareWaPlaylist = $('#share-wa-playlist');
    if (shareWaPlaylist) {
        shareWaPlaylist.addEventListener('click', () => {
            const urls = getShareUrls();
            if (!urls) { UI.toast('Guardá el proyecto primero', 'error'); return; }
            const sel = $('#share-panel-playlist-select');
            const plId = sel ? sel.value : '';
            if (!plId) { UI.toast('Seleccioná una playlist', 'error'); return; }
            const url = urls.base + '&playlist=' + plId + '&mode=view';
            openWhatsApp(url, 'Playlist de análisis:');
        });
    }

    async function ensureCollectionShareAndGetViewUrl() {
        if (!AppState.hasFeature(FEATURES.SHARE)) {
            UI.toast(getProFeatureMessage(), 'info');
            return null;
        }
        const col = AppState.get('activeCollection');
        if (!col?.id) {
            UI.toast('Guardá la colección primero', 'error');
            return null;
        }
        let toShare = col;
        if (!col.isPublic) {
            try {
                const updated = { ...col, isPublic: true };
                await FirebaseData.saveCollection(col.id, updated);
                AppState.openCollection(updated, { clearProject: false });
                toShare = updated;
            } catch (e) {
                UI.toast('No se pudo activar el enlace: ' + (e.message || String(e)), 'error');
                return null;
            }
        }
        return FirebaseData.getCollectionShareUrl(toShare.id);
    }

    const shareCopyCollection = $('#share-copy-collection');
    if (shareCopyCollection) {
        shareCopyCollection.addEventListener('click', async (e) => {
            e.stopPropagation();
            const url = await ensureCollectionShareAndGetViewUrl();
            if (!url) return;
            navigator.clipboard.writeText(url).then(() => {
                UI.toast('🔗 Enlace de colección copiado', 'success');
            }).catch(() => prompt('Copiá este link:', url));
        });
    }

    const shareWaCollection = $('#share-wa-collection');
    if (shareWaCollection) {
        shareWaCollection.addEventListener('click', async (e) => {
            e.stopPropagation();
            const url = await ensureCollectionShareAndGetViewUrl();
            if (!url) return;
            openWhatsApp(url, 'Colección SimpleReplay:');
        });
    }

    const sharePanelXml = $('#share-btn-xml');
    if (sharePanelXml) {
        sharePanelXml.addEventListener('click', async () => {
            if (!AppState.hasFeature(FEATURES.EXPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const xml = AppState.exportXML ? AppState.exportXML() : null;
            if (xml) {
                const game = AppState.getCurrentGame();
                const title = game && game.title ? game.title : 'SimpleReplay';
                const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.xml`;
                ExportManager.download(xml, filename);
            } else {
                UI.toast('No hay proyecto activo para exportar', 'error');
            }
        });
    }

    const sharePanelJson = $('#share-btn-json');
    if (sharePanelJson) {
        sharePanelJson.addEventListener('click', () => {
            if (!AppState.hasFeature(FEATURES.EXPORT_DATA)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const data = AppState.exportProjectData();
            if (data) {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `SimpleReplay_${data.game.title.replace(/\s+/g, '_')}.json`;
                a.click();
            } else {
                UI.toast('No hay un proyecto activo para exportar', 'error');
            }
        });
    }

    // Re-render share panel when playlists change (in case panel is active)
    AppState.on('playlistsUpdated', () => {
        if (AppState.get('mode') === 'share') UI.renderSharePanel();
    });
    // Update share panel state when project is saved/loaded
    AppState.on('projectSaved', () => {
        if (AppState.get('mode') === 'share') UI.renderSharePanel();
    });
    AppState.on('projectLoaded', () => {
        if (AppState.get('mode') === 'share') UI.renderSharePanel();
    });

    // ═══════════════════════════════════════
    // PLAYLIST SHARE
    // ═══════════════════════════════════════

    const handlePlaylistShare = async (e) => {
        const shareBtn = e.target.closest('.pl-share-btn');
        if (shareBtn) {
            if (!AppState.hasFeature(FEATURES.SHARE)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const playlistId = shareBtn.dataset.playlistId;
            let projectId = AppState.get('currentProjectId');

            // Auto-guardar primero si estamos en modo editar y tocamos el link
            if (AppState.get('mode') === 'analyze') {
                const saveBtn = $('#btn-save-project');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳'; }
                UI.toast('Guardando cambios antes de compartir...', 'info');
                try {
                    projectId = await AppState.saveToCloud();
                    FirebaseData.addProjectLocally(projectId);
                } catch (err) {
                    UI.toast('Error al guardar: ' + err.message, 'error');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾'; }
                    return;
                }
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾'; }
            }

            if (!projectId) {
                UI.toast('Primero guardá el proyecto para compartir', 'error');
                return;
            }

            const url = FirebaseData.getShareUrl(projectId, null, playlistId) + '&mode=view';
            navigator.clipboard.writeText(url).then(() => {
                UI.toast('🔗 Link de Playlist copiado', 'success');
            }).catch(() => {
                prompt('Copiá este link:', url);
            });
            return;
        }

        const waBtn = e.target.closest('.pl-wa-btn');
        if (waBtn) {
            if (!AppState.hasFeature(FEATURES.SHARE)) { UI.toast(getProFeatureMessage(), 'info'); return; }
            const playlistId = waBtn.dataset.playlistId;
            let projectId = AppState.get('currentProjectId');

            if (!projectId) {
                UI.toast('Primero guardá el proyecto para compartir', 'error');
                return;
            }

            const url = FirebaseData.getShareUrl(projectId, null, playlistId) + '&mode=view';
            const msg = encodeURIComponent('Playlist de análisis:\n' + url);
            window.open('https://wa.me/?text=' + msg, '_blank');
            return;
        }

        // Navegar automáticamente a la vista de la playlist si hacen clic en el nombre
        const nameBtn = e.target.closest('.pl-name-click');
        if (nameBtn) {
            const playlistId = nameBtn.dataset.playlistId;
            AppState.setPlaylistFilter(playlistId);
            AppState.setMode('view');
        }
    };

    $('#analyze-playlists').addEventListener('click', handlePlaylistShare);
    // También escuchamos los clicks de compartir playlist en la vista "Ver"
    const sourcePlaylistsCont = $('#source-playlists');
    if (sourcePlaylistsCont) {
        sourcePlaylistsCont.addEventListener('click', handlePlaylistShare);
    }

    // ═══════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════

    async function init() {
        // Apply permission-based visibility immediately to avoid PRO UI flicker.
        UI.updateMode();

        // ── Player + LiveCapture + __SIMPLE_REPLAY_DEV__ ANTES de auth/Firestore ──
        // Así la consola puede probar loadLiveCapture sin esperar getUserDoc ni proyectos.
        try {
            await YTPlayer.init();
        } catch (e) {
            console.warn('YouTube Player no se pudo iniciar inmediatamente (común en file://).', e);
        }

        /** @type {import('./livecapture/LiveCaptureFacade.js').LiveCaptureFacade|null} */
        let liveCaptureFacade = null;
        try {
            liveCaptureFacade = new LiveCaptureFacade();
            liveCaptureFacade.initFromDom();
            if (typeof YTPlayer.setLiveFacade === 'function') {
                YTPlayer.setLiveFacade(liveCaptureFacade);
            }
        } catch (e) {
            console.warn('LiveCapture facade no se pudo inicializar:', e);
        }
        _liveCaptureFacadeRef = liveCaptureFacade;

        attachSimpleReplayDevApi({ YTPlayer, liveFacade: liveCaptureFacade, AppState });

        await waitForAuthReady();
        AppState.setAuthenticatedUser(getCurrentUser());
        updateAuthHeader(getCurrentUser());

        wireAuthMenu();

        // Check if loading a shared project from URL
        const projectIdFromUrl = FirebaseData.getProjectIdFromUrl();
        const playlistIdFromUrl = FirebaseData.getPlaylistIdFromUrl();
        const gameIdFromUrl = FirebaseData.getGameIdFromUrl();
        const params = new URLSearchParams(window.location.search);
        const modeFromUrl = params.get('mode');
        const deferSharedPlaylistRender = modeFromUrl === 'view' && !!playlistIdFromUrl;
        if (deferSharedPlaylistRender) {
            // Prevent initial full-list flash while shared-playlist filter locks in.
            document.body.classList.add('initial-playlist-lock-loading');
        }
        // Reset read-only UI state before deciding access for the current project.
        document.body.classList.remove('read-only-mode', 'read-only-pro');
        let projectIdToLoad = projectIdFromUrl;

        if (!projectIdToLoad) {
            const currentUser = getCurrentUser();
            if (currentUser?.uid) {
                try {
                    const userDoc = await getUserDoc(currentUser.uid);
                    const lastProjectId = typeof userDoc?.lastProjectId === 'string'
                        ? userDoc.lastProjectId.trim()
                        : '';
                    if (lastProjectId) {
                        projectIdToLoad = lastProjectId;
                    }
                } catch (e) {
                    console.warn('No se pudo leer lastProjectId del usuario:', e);
                }
            }
        }

        const collectionIdFromUrl = FirebaseData.getCollectionIdFromUrl();
        if (collectionIdFromUrl && !projectIdFromUrl) {
            projectIdToLoad = null;
        }

        if (projectIdToLoad) {
            // No cargamos los clips demo si vamos a intentar abrir un proyecto cloud.
            DemoData.clear();
        }

        // Wire popout controller to the player commands
        try {
            wirePopout();
        } catch (e) {
            console.warn('Popout controller no se pudo iniciar:', e);
        }
        try {
            wirePlayerChrome();
        } catch (e) {
            console.warn('Controles del reproductor no se pudieron iniciar:', e);
        }
        try {
            wirePlayerSurfaceToggle();
        } catch (e) {
            console.warn('Toggle por click en video no se pudo iniciar:', e);
        }

        // Init state (loads whatever is in DemoData)
        AppState.init();

        try {
            wireLiveCaptureAnalyzeTab(liveCaptureFacade);
        } catch (e) {
            console.warn('Captura en vivo (panel):', e);
        }

        // Init timeline
        if (typeof Timeline !== 'undefined') {
            Timeline.init();
        }

        // Init drawing tool
        if (typeof DrawingTool !== 'undefined') {
            DrawingTool.init();
        }

        if (projectIdToLoad) {
            UI.toast(projectIdFromUrl ? 'Cargando proyecto...' : 'Cargando último proyecto...', '');
            const loaded = await AppState.loadFromCloud(projectIdToLoad, {
                initialPlaylistId: playlistIdFromUrl || '',
            });

            if (loaded) {
                if (projectIdFromUrl) {
                    // Determine if this project was already in our local 'owned' list
                    const localProjects = JSON.parse(localStorage.getItem('sr_my_projects') || '[]');
                    const isOwned = localProjects.some(p => {
                        if (typeof p === 'string') return p === projectIdToLoad;
                        return p.id === projectIdToLoad && p.shared === false;
                    });
                    FirebaseData.addProjectLocally(projectIdToLoad, !isOwned); // Save as shared if we don't own it
                } else {
                    const u = getCurrentUser();
                    if (u?.uid) {
                        const owner = loaded.ownerUid || '';
                        if (!owner || owner === u.uid) {
                            FirebaseData.addProjectLocally(projectIdToLoad, false);
                        }
                    }
                }
                await Promise.all([
                    FirebaseData.markProjectOpened(projectIdToLoad),
                    rememberLastProject(projectIdToLoad),
                ]);
                UI.toast('Proyecto cargado ✅', 'success');

                if (gameIdFromUrl) {
                    AppState.setCurrentGame(gameIdFromUrl);
                } else {
                    const games = AppState.get('games');
                    if (games.length > 0) {
                        // For backward compatibility with older multi-game projects, 
                        // try to auto-select the game with the most clips rather than just [0]
                        const allClips = AppState.get('clips');
                        let bestGameId = games[0].id;
                        let maxClips = -1;
                        games.forEach(g => {
                            const count = allClips.filter(c => c.game_id === g.id).length;
                            if (count > maxClips) {
                                maxClips = count;
                                bestGameId = g.id;
                            }
                        });
                        AppState.setCurrentGame(bestGameId);
                    }
                }

                const game = AppState.getCurrentGame();
                if (game) {
                    if (game.local_video_url) {
                        YTPlayer.loadLocalVideo(game.local_video_url);
                    } else if (game.youtube_video_id) {
                        YTPlayer.loadVideo(game.youtube_video_id);
                    }
                }

                // Determine read-only mode:
                // 1. Explicit ?mode=view in URL, OR
                // 2. Project has an editKey but the URL doesn't carry a matching one
                //    (old projects without editKey are unaffected — backward compatible)
                const storedEditKey = AppState.get('editKey');
                const editKeyFromUrl = FirebaseData.getEditKeyFromUrl();
                const currentUser = getCurrentUser();
                const isCollaborativeButLoggedOut = !!editKeyFromUrl && !currentUser;
                const hasEditKeyInUrl = !!editKeyFromUrl;
                const hasStoredEditKey = !!storedEditKey;
                const isEditKeyMismatch = hasEditKeyInUrl && hasStoredEditKey && editKeyFromUrl !== storedEditKey;
                const isReadOnlyAccess = modeFromUrl === 'view' ||
                    isCollaborativeButLoggedOut ||
                    isEditKeyMismatch;

                if (isReadOnlyAccess) {
                    document.body.classList.add('read-only-mode');
                    syncReadOnlyCapabilitiesClass();
                    AppState.setMode('view');
                    if (isCollaborativeButLoggedOut) {
                        UI.toast('Este link colaborativo requiere iniciar sesión para editar. Estás en solo lectura.', 'error');
                    }
                    if (!playlistIdFromUrl) {
                        setTimeout(() => {
                            const plList = document.getElementById('source-playlists-list');
                            const plToggle = document.querySelector('[data-toggle="source-playlists-list"]');
                            if (plList) plList.classList.remove('collapsed');
                            if (plToggle) plToggle.classList.add('open');
                        }, 50);
                    }
                } else {
                    document.body.classList.remove('read-only-mode', 'read-only-pro');
                }
            } else {
                document.body.classList.remove('read-only-mode', 'read-only-pro');
                if (!projectIdFromUrl) {
                    UI.toast('No se pudo cargar tu último proyecto. Se abrió el demo.', 'info');
                    const games = AppState.get('games');
                    if (games.length > 0) {
                        AppState.setCurrentGame(games[0].id);
                    }
                } else {
                    UI.toast('No se pudo cargar el proyecto', 'error');
                }
            }
        } else {
            document.body.classList.remove('read-only-mode', 'read-only-pro');
            // Auto-select first game for demo
            const games = AppState.get('games');
            if (games.length > 0) {
                AppState.setCurrentGame(games[0].id);
            }
        }

        if (collectionIdFromUrl && !projectIdFromUrl) {
            UI.toast('Cargando colección...', '');
            const colData = await FirebaseData.loadCollection(collectionIdFromUrl);
            if (colData) {
                AppState.openCollection(colData);
                const u = getCurrentUser();
                const isOwner = !!(u?.uid && colData.ownerUid && colData.ownerUid === u.uid);
                if (!isOwner) {
                    document.body.classList.add('read-only-mode');
                    syncReadOnlyCapabilitiesClass();
                    AppState.setMode('view');
                    UI.updateMode();
                } else {
                    document.body.classList.remove('read-only-mode', 'read-only-pro');
                }
                UI.toast('Colección cargada ✅', 'success');
            } else {
                UI.toast('No se pudo cargar la colección. Si es tuya, iniciá sesión; si la compartieron, el dueño debe generar el enlace.', 'error');
            }
        }

        // Apply playlist-only mode if requested
        if (playlistIdFromUrl) {
            document.body.classList.add('playlist-only-mode');
            AppState.setMode('view');
            AppState.setPlaylistFilter(playlistIdFromUrl);
        }

        // Render initial UI
        UI.refreshAll();
        document.body.classList.remove('initial-playlist-lock-loading');
        updateLiveEdgeButton();
        wireAutoSaveLoop();
        syncAutoSaveMenuState();
        syncHeaderProFeatureStates();
        setInterval(updateLiveEdgeButton, 1000);
    }

    init();

})();
