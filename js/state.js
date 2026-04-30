/* ═══════════════════════════════════════════
   SimpleReplay — State Management
   Simple event-driven store
   ═══════════════════════════════════════════ */

import { DemoData } from './demoData.js';
import { FirebaseData } from './firebaseData.js';
import { ExportManager } from './export.js';

/** userId when Firebase Auth has no signed-in user (not a Firebase uid) */
const ANONYMOUS_USER_ID = 'anonymous';

export const AppState = (() => {
  // Internal state
  const state = {
    mode: 'analyze',           // 'analyze' | 'view'
    currentGameId: null,
    currentClipId: null,
    currentClipIndex: -1,
    panelCollapsed: false,
    focusView: false,

    // Data
    games: [],
    tagTypes: [],
    activeButtonboards: [],     // [ { id, name, buttons[] } ] — project-local copies
    clips: [],                 // clips for current game
    playlists: [],             // playlists for current game
    playlistItems: {},         // { playlistId: [clipId, ...] }
    clipFlags: {},             // { clipId: [{ flag, userId }] }
    playlistComments: {},       // { "playlistId::clipId": [{ name, text, timestamp }] }
    activityLog: [],            // [{ type, name, playlistName, clipCount, timestamp }]

    // View mode filters
    activeTagFilters: [],      // array of tag type IDs
    activePlaylistId: null,    // single playlist ID or null
    filterFlags: [],           // active flag filters

    // User (Firebase uid when logged in, else ANONYMOUS_USER_ID)
    userId: ANONYMOUS_USER_ID,
    authUser: null,

    // Cloud project
    currentProjectId: null,
    editKey: null,             // edit access token (null = no auth yet)

    // Feature flags { featureName: true/false }
    featureFlags: {},

    /** @type {File|null} Video local en memoria (misma sesión). No se persiste en la nube. */
    localVideoFile: null,

    // Active open collection (cross-project, not saved inside a project doc)
    activeCollection: null,      // { id, name, ownerUid, items: [...] }
    activeCollectionItemIdx: -1,
  };

  // Listeners
  const listeners = {};

  function on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  }

  function off(event, cb) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(fn => fn !== cb);
  }

  function emit(event, data) {
    (listeners[event] || []).forEach(cb => cb(data));
  }

  // Getters
  // NOTE: get('tagTypes') transparently returns the active buttonboard's buttons
  // so that renderTagButtons() and all other callers need zero changes.
  function getActiveTagTypes() {
    if (state.activeButtonboards && state.activeButtonboards.length > 0) {
      return state.activeButtonboards[0].buttons;
    }
    return state.tagTypes;
  }

  function get(key) {
    if (key === 'tagTypes') return getActiveTagTypes();
    return state[key];
  }

  function getCurrentGame() {
    return state.games.find(g => g.id === state.currentGameId) || null;
  }

  function getLocalVideoFile() {
    return state.localVideoFile;
  }

  function setLocalVideoFile(file) {
    state.localVideoFile = (file && typeof file === 'object' && 'arrayBuffer' in file) ? file : null;
  }

  function getCurrentClip() {
    return state.clips.find(c => c.id === state.currentClipId) || null;
  }

  function getTagType(id) {
    const activeTag = getActiveTagTypes().find(t => t.id === id);
    if (activeTag) return activeTag;
    return state.tagTypes.find(t => t.id === id);
  }

  /** Botonera activa + tags solo en state.tagTypes (p. ej. import XML). Para filtros en modo Ver sin llenar la botonera. */
  function getTagTypesForFilter() {
    const active = getActiveTagTypes();
    const byId = new Map();
    active.forEach(t => byId.set(t.id, t));
    state.tagTypes.forEach(t => {
      if (!byId.has(t.id)) byId.set(t.id, t);
    });
    return Array.from(byId.values());
  }

  function getFilteredClips() {
    let clips = [...state.clips];

    // Filter by playlist (exclusive)
    if (state.activePlaylistId) {
      const itemClipIds = state.playlistItems[state.activePlaylistId] || [];
      clips = clips.filter(c => itemClipIds.includes(c.id));
    }

    // Filter by tags (any of selected, additive)
    if (state.activeTagFilters.length > 0) {
      clips = clips.filter(c => state.activeTagFilters.includes(c.tag_type_id));
    }

    // Filter by flags and/or chat (cross-filter)
    if (state.filterFlags.length > 0) {
      const realFlags = state.filterFlags.filter(f => f !== 'has_chat');
      const wantChat = state.filterFlags.includes('has_chat');
      clips = clips.filter(c => {
        let match = false;
        if (realFlags.length > 0) {
          const flags = (state.clipFlags[c.id] || [])
            .filter(f => f.userId === state.userId)
            .map(f => f.flag);
          match = realFlags.some(ff => flags.includes(ff));
        }
        if (wantChat) {
          // Check if clip has comments in any playlist
          match = match || Object.keys(state.playlistComments).some(key => {
            return key.endsWith('::' + c.id) && state.playlistComments[key].length > 0;
          });
        }
        return match;
      });
    }

    // Sort logic
    if (state.activePlaylistId) {
      // If a playlist is active, sort by arbitrary user order (index in playlistItems array)
      const itemClipIds = state.playlistItems[state.activePlaylistId] || [];
      clips.sort((a, b) => {
        const idxA = itemClipIds.indexOf(a.id);
        const idxB = itemClipIds.indexOf(b.id);
        return (idxA !== -1 ? idxA : 9999) - (idxB !== -1 ? idxB : 9999);
      });
    } else {
      // Otherwise, sort strictly chronologically by t_sec
      clips.sort((a, b) => a.t_sec - b.t_sec);
    }

    return clips;
  }

  function getClipUserFlags(clipId) {
    return (state.clipFlags[clipId] || [])
      .filter(f => f.userId === state.userId)
      .map(f => f.flag);
  }

  // Setters / mutations
  function setMode(mode) {
    state.mode = mode;
    emit('modeChanged', mode);
  }

  function setCurrentGame(gameId) {
    state.currentGameId = gameId;
    state.localVideoFile = null;
    state.currentClipId = null;
    state.currentClipIndex = -1;
    // Load clips/playlists for this game
    const game = getCurrentGame();
    if (game) {
      state.clips = DemoData.getClipsForGame(gameId);
      state.playlists = DemoData.getPlaylistsForGame(gameId);
      state.playlistItems = {};
      state.playlists.forEach(pl => {
        state.playlistItems[pl.id] = DemoData.getPlaylistItems(pl.id);
      });
      // Load flags for all clips
      state.clipFlags = {};
      state.clips.forEach(c => {
        state.clipFlags[c.id] = DemoData.getClipFlags(c.id);
      });
    } else {
      state.clips = [];
      state.playlists = [];
      state.playlistItems = {};
      state.clipFlags = {};
    }
    state.activeTagFilters = [];
    state.activePlaylistId = null;
    state.filterFlags = [];
    emit('gameChanged', game);
  }

  function setCurrentClip(clipId) {
    state.currentClipId = clipId;
    const filtered = getFilteredClips();
    state.currentClipIndex = filtered.findIndex(c => c.id === clipId);
    emit('clipChanged', getCurrentClip());
  }

  function addGame(title, youtubeVideoId, localVideoUrl = null) {
    const game = DemoData.createGame(title, youtubeVideoId, localVideoUrl, state.userId);
    state.games = DemoData.getGames();
    emit('gamesUpdated', state.games);
    return game;
  }

  function addClip(tagTypeId, tSec) {
    const tag = getTagType(tagTypeId);
    if (!tag) return null;
    const startSec = Math.max(0, tSec - tag.pre_sec);
    const endSec = tSec + tag.post_sec;
    if (endSec <= startSec) return null;

    const clip = DemoData.createClip(state.currentGameId, tagTypeId, tSec, startSec, endSec, state.userId);
    state.clips = DemoData.getClipsForGame(state.currentGameId);
    state.clipFlags[clip.id] = [];
    emit('clipsUpdated', state.clips);
    return clip;
  }

  function updateClipBounds(clipId, field, delta) {
    const clip = state.clips.find(c => c.id === clipId);
    if (!clip) return;

    if (field === 'start_sec') {
      clip.start_sec = Math.max(0, clip.start_sec + delta);
      if (clip.start_sec >= clip.end_sec) clip.start_sec = clip.end_sec - 1;
    } else if (field === 'end_sec') {
      clip.end_sec = clip.end_sec + delta;
      if (clip.end_sec <= clip.start_sec) clip.end_sec = clip.start_sec + 1;
    }
    DemoData.updateClip(clipId, { start_sec: clip.start_sec, end_sec: clip.end_sec });
    emit('clipsUpdated', state.clips);
    emit('clipChanged', clip);
  }

  function updateClipAbsoluteBounds(clipId, startSec, endSec) {
    const clip = state.clips.find(c => c.id === clipId);
    if (!clip) return;

    clip.start_sec = Math.max(0, startSec);
    clip.end_sec = Math.max(clip.start_sec + 1, endSec);

    DemoData.updateClip(clipId, { start_sec: clip.start_sec, end_sec: clip.end_sec });
    emit('clipsUpdated', state.clips);
    emit('clipChanged', clip);
  }

  function deleteClip(clipId) {
    DemoData.deleteClip(clipId);
    state.clips = DemoData.getClipsForGame(state.currentGameId);
    if (state.currentClipId === clipId) {
      state.currentClipId = null;
      state.currentClipIndex = -1;
    }
    delete state.clipFlags[clipId];
    emit('clipsUpdated', state.clips);
    emit('clipChanged', null);
  }

  function addPlaylist(name) {
    const pl = DemoData.createPlaylist(state.currentGameId, name, state.userId);
    state.playlists = DemoData.getPlaylistsForGame(state.currentGameId);
    state.playlistItems[pl.id] = [];
    emit('playlistsUpdated', state.playlists);
    return pl;
  }

  function addClipToPlaylist(playlistId, clipId) {
    DemoData.addClipToPlaylist(playlistId, clipId);
    state.playlistItems[playlistId] = DemoData.getPlaylistItems(playlistId);
    emit('playlistsUpdated', state.playlists);
  }

  function removeClipFromPlaylist(playlistId, clipId) {
    DemoData.removeClipFromPlaylist(playlistId, clipId);
    state.playlistItems[playlistId] = DemoData.getPlaylistItems(playlistId);
    emit('playlistsUpdated', state.playlists);
    emit('viewFiltersChanged');
  }

  function renamePlaylist(playlistId, newName) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (pl) {
      pl.name = newName;
      // Also update in DemoData
      const demoPlaylists = DemoData.getPlaylistsForGame(state.currentGameId);
      const demoPl = demoPlaylists.find(p => p.id === playlistId);
      if (demoPl) demoPl.name = newName;
      emit('playlistsUpdated', state.playlists);
    }
  }

  function deletePlaylist(playlistId) {
    state.playlists = state.playlists.filter(p => p.id !== playlistId);
    delete state.playlistItems[playlistId];
    // Remove from DemoData
    DemoData.deletePlaylist(playlistId);
    if (state.activePlaylistId === playlistId) {
      state.activePlaylistId = null;
    }
    emit('playlistsUpdated', state.playlists);
    emit('viewFiltersChanged');
  }

  function reorderPlaylist(playlistId, oldIndex, newIndex) {
    if (!state.playlistItems[playlistId]) return;
    const items = [...state.playlistItems[playlistId]];
    if (oldIndex < 0 || oldIndex >= items.length || newIndex < 0 || newIndex >= items.length) return;

    // Move item
    const [moved] = items.splice(oldIndex, 1);
    items.splice(newIndex, 0, moved);

    state.playlistItems[playlistId] = items;

    // Re-sync current clip index if current clip is playing
    if (state.currentClipId) {
      const filtered = getFilteredClips();
      state.currentClipIndex = filtered.findIndex(c => c.id === state.currentClipId);
    }

    emit('playlistsUpdated', state.playlists);
  }

  function toggleFlag(clipId, flag) {
    const flags = getClipUserFlags(clipId);
    if (flags.includes(flag)) {
      DemoData.removeFlag(clipId, state.userId, flag);
    } else {
      DemoData.addFlag(clipId, state.userId, flag);
    }
    state.clipFlags[clipId] = DemoData.getClipFlags(clipId);
    emit('flagsUpdated', { clipId, flags: getClipUserFlags(clipId) });
  }

  function toggleTagFilter(tagId, isMulti = false) {
    const idx = state.activeTagFilters.indexOf(tagId);
    if (idx >= 0) {
      // Already selected → deselect (remove it)
      state.activeTagFilters.splice(idx, 1);
    } else {
      // Not selected
      if (isMulti) {
        state.activeTagFilters.push(tagId);
      } else {
        // Normal mode → replace any existing filter with only this one
        state.activeTagFilters = [tagId];
      }
    }

    state.currentClipId = null;
    state.currentClipIndex = -1;
    emit('viewFiltersChanged');
  }

  function removeTagFilter(tagId) {
    const idx = state.activeTagFilters.indexOf(tagId);
    if (idx >= 0) state.activeTagFilters.splice(idx, 1);
    state.currentClipId = null;
    state.currentClipIndex = -1;
    emit('viewFiltersChanged');
  }

  function clearTagFilters() {
    state.activeTagFilters = [];
    state.currentClipId = null;
    state.currentClipIndex = -1;
    emit('viewFiltersChanged');
  }

  function clearAllFilters() {
    state.activeTagFilters = [];

    // Do not clear playlist if locked
    const urlParams = new URLSearchParams(window.location.search);
    if (!(urlParams.get('mode') === 'view' && urlParams.get('playlist'))) {
      state.activePlaylistId = null;
    }

    state.filterFlags = [];
    state.currentClipId = null;
    state.currentClipIndex = -1;
    emit('viewFiltersChanged');
  }

  function setPlaylistFilter(playlistId) {
    state.activePlaylistId = playlistId;
    state.currentClipId = null;
    state.currentClipIndex = -1;
    emit('viewFiltersChanged');
  }

  function clearPlaylistFilter() {
    // Hard-lock: cannot clear if viewing a specifically shared playlist
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') === 'view' && urlParams.get('playlist')) {
      console.warn('Blocked attempt to clear locked shared playlist');
      return;
    }

    state.activePlaylistId = null;
    state.currentClipId = null;
    state.currentClipIndex = -1;
    emit('viewFiltersChanged');
  }

  function toggleFilterFlag(flag) {
    const idx = state.filterFlags.indexOf(flag);
    if (idx >= 0) {
      state.filterFlags.splice(idx, 1);
    } else {
      state.filterFlags.push(flag);
    }
    emit('viewFiltersChanged');
  }

  function clearFilterFlags() {
    state.filterFlags = [];
    emit('viewFiltersChanged');
  }

  // Tag CRUD
  // After any mutation we sync state.tagTypes back to activeButtonboards[0].buttons
  // so the project-local copy stays up-to-date when the user edits tags inline.
  function _syncTagsToActiveBoard() {
    if (state.activeButtonboards && state.activeButtonboards.length > 0) {
      state.activeButtonboards[0].buttons = [...state.tagTypes];
    }
  }

  function addTagType(data) {
    const tag = DemoData.createTagType(data);
    state.tagTypes = DemoData.getTagTypes();
    _syncTagsToActiveBoard();
    emit('tagTypesUpdated', state.tagTypes);
    return tag;
  }

  function updateTagType(id, changes) {
    DemoData.updateTagType(id, changes);
    state.tagTypes = DemoData.getTagTypes();
    _syncTagsToActiveBoard();
    emit('tagTypesUpdated', state.tagTypes);
  }

  function deleteTagType(id) {
    DemoData.deleteTagType(id);
    state.tagTypes = DemoData.getTagTypes();
    _syncTagsToActiveBoard();
    emit('tagTypesUpdated', state.tagTypes);
  }

  // ── Collection view (cross-project) ──
  /**
   * @param {object} colData
   * @param {{ clearProject?: boolean }} [options] — default: clear project and enter view (like opening another context)
   */
  function openCollection(colData, options = {}) {
    const shouldClear = options.clearProject !== false;
    if (shouldClear) {
      clearProject();
      DemoData.clear();
      state.tagTypes = DemoData.getTagTypes();
      emit('tagTypesUpdated', state.tagTypes);
      emit('buttonboardsChanged', state.activeButtonboards);
      setMode('view');
    }
    state.activeCollection = colData;
    if (shouldClear) {
      state.activeCollectionItemIdx = -1;
    }
    emit('collectionOpened', colData);
    if (shouldClear && colData.items && colData.items.length > 0) {
      setCollectionItemIndex(0);
    }
  }

  function closeCollection() {
    state.activeCollection = null;
    state.activeCollectionItemIdx = -1;
    emit('collectionClosed');
  }

  function setCollectionItemIndex(idx) {
    if (!state.activeCollection) return null;
    const items = state.activeCollection.items || [];
    if (idx < 0 || idx >= items.length) return null;
    state.activeCollectionItemIdx = idx;
    emit('collectionItemChanged', items[idx]);
    return items[idx];
  }

  function navigateCollectionItem(direction) {
    if (!state.activeCollection) return null;
    const items = state.activeCollection.items || [];
    if (!items.length) return null;
    let idx = state.activeCollectionItemIdx;
    idx = direction === 'next'
      ? Math.min(items.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    return setCollectionItemIndex(idx);
  }

  function removeCollectionItem(idx) {
    if (!state.activeCollection) return;
    const items = [...(state.activeCollection.items || [])];
    items.splice(idx, 1);
    state.activeCollection = { ...state.activeCollection, items };
    if (state.activeCollectionItemIdx >= items.length) {
      state.activeCollectionItemIdx = items.length - 1;
    }
    emit('collectionItemsChanged', items);
    return state.activeCollection;
  }

  function reorderCollectionItems(oldIdx, newIdx) {
    if (!state.activeCollection) return;
    const items = [...(state.activeCollection.items || [])];
    const [moved] = items.splice(oldIdx, 1);
    items.splice(newIdx, 0, moved);
    state.activeCollection = { ...state.activeCollection, items };
    emit('collectionItemsChanged', items);
    return state.activeCollection;
  }

  function togglePanel() {
    state.panelCollapsed = !state.panelCollapsed;
    emit('panelToggled', state.panelCollapsed);
  }

  function toggleFocusView() {
    state.focusView = !state.focusView;
    if (state.focusView && !state.panelCollapsed) {
      state.panelCollapsed = true;
      emit('panelToggled', true);
    } else if (!state.focusView && state.panelCollapsed) {
      state.panelCollapsed = false;
      emit('panelToggled', false);
    }
    emit('focusViewToggled', state.focusView);
  }

  function navigateClip(direction) {
    const filtered = getFilteredClips();
    if (filtered.length === 0) return;
    let idx = state.currentClipIndex;
    if (direction === 'next') {
      idx = Math.min(filtered.length - 1, idx + 1);
    } else {
      idx = Math.max(0, idx - 1);
    }
    if (idx >= 0 && idx < filtered.length) {
      setCurrentClip(filtered[idx].id);
    }
  }

  function init() {
    state.tagTypes = DemoData.getTagTypes();
    state.games = DemoData.getGames();
    emit('initialized', state);
  }

  function setFeatureFlags(flags) {
    state.featureFlags = flags || {};
    emit('featuresChanged', state.featureFlags);
  }

  function hasFeature(feature) {
    return !!state.featureFlags[feature];
  }

  function setAuthenticatedUser(user) {
    if (user) {
      state.userId = user.uid;
      state.authUser = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || '',
      };
    } else {
      state.userId = ANONYMOUS_USER_ID;
      state.authUser = null;
    }
    emit('authUserChanged', state.authUser);
  }

  function clearProject() {
    state.currentGameId = null;
    state.localVideoFile = null;
    state.currentClipId = null;
    state.currentClipIndex = -1;
    state.games = [];
    state.clips = [];
    state.playlists = [];
    state.playlistItems = {};
    state.clipFlags = {};
    state.playlistComments = {};
    state.activityLog = [];
    state.activeTagFilters = [];
    state.activePlaylistId = null;
    state.filterFlags = [];
    state.currentProjectId = null;
    state.editKey = null;
    state.activeButtonboards = [];
    emit('gameChanged', null);
  }

  // ── Buttonboard management ──
  // Sets the full list of active buttonboards for the current project and
  // syncs the legacy state.tagTypes so DemoData-based tag mutations still work.
  function setActiveButtonboards(list) {
    state.activeButtonboards = list || [];
    // Keep state.tagTypes in sync so DemoData mutations (addTagType etc.) operate
    // on the same data that getActiveTagTypes() returns.
    if (state.activeButtonboards.length > 0) {
      // Load the active board's buttons into DemoData so CRUD fns stay consistent
      const buttons = state.activeButtonboards[0].buttons || [];
      state.tagTypes = [...buttons];
      DemoData.restoreTagTypes(buttons);
    }
    emit('buttonboardsChanged', state.activeButtonboards);
    emit('tagTypesUpdated', getActiveTagTypes());
  }

  // ── Chat / Comments (per playlist) ──
  function addComment(playlistId, clipId, name, text, drawing, videoTimeSec) {
    const key = playlistId + '::' + clipId;
    if (!state.playlistComments[key]) state.playlistComments[key] = [];
    const comment = {
      name,
      text,
      timestamp: new Date().toISOString()
    };
    // Optional drawing data (PNG data URL)
    if (drawing) {
      comment.drawing = drawing;
      comment.videoTimeSec = videoTimeSec !== undefined ? videoTimeSec : null;
    }
    state.playlistComments[key].push(comment);
    emit('commentAdded', { playlistId, clipId, comment });
    if (drawing) emit('clipCommentsUpdated');
    return comment;
  }

  function getPreferredChatName() {
    const auth = state.authUser;
    if (auth) {
      const fromAuth = (auth.displayName || auth.email || '').trim();
      if (fromAuth) return fromAuth;
    }
    if (typeof localStorage !== 'undefined') {
      const saved = (localStorage.getItem('sr_chat_name') || '').trim();
      if (saved) return saved;
    }
    return 'Anónimo';
  }

  function getComments(playlistId, clipId) {
    const key = playlistId + '::' + clipId;
    return state.playlistComments[key] || [];
  }

  function removeComment(playlistId, clipId, timestamp) {
    const key = playlistId + '::' + clipId;
    if (!state.playlistComments[key]) return;
    state.playlistComments[key] = state.playlistComments[key].filter(c => c.timestamp !== timestamp);
    emit('commentAdded', { playlistId, clipId }); // reuse event to trigger re-render
  }

  // Helper: get sequential clip number per tag type
  function getClipNumber(clip) {
    const allClips = state.clips.filter(c => c.tag_type_id === clip.tag_type_id);
    allClips.sort((a, b) => a.t_sec - b.t_sec);
    const idx = allClips.findIndex(c => c.id === clip.id);
    return idx + 1;
  }

  // ── Activity Log ──
  function addActivity(type, details) {
    const name = getPreferredChatName();
    const entry = {
      type,
      name,
      ...details,
      timestamp: new Date().toISOString()
    };
    state.activityLog.push(entry);
    emit('activityLogUpdated', entry);
    return entry;
  }

  function getActivityLog() {
    return state.activityLog;
  }

  function getActorUidForOwnership() {
    if (state.authUser?.uid) return state.authUser.uid;
    if (state.userId) return state.userId;
    return ANONYMOUS_USER_ID;
  }

  function withCreatedBy(items, actorUid) {
    if (!Array.isArray(items)) return [];
    if (!actorUid) return [...items];
    return items.map((item) => ({ ...item, created_by: actorUid }));
  }

  // ── Cloud save/load ──
  async function saveToCloud() {
    // Generate an editKey on first save
    if (!state.editKey) {
      state.editKey = Array.from(crypto.getRandomValues(new Uint8Array(5)))
        .map(b => b.toString(36)).join('').slice(0, 7);
    }

    const game = getCurrentGame();
    const actorUid = getActorUidForOwnership();
    const ownerUid = actorUid === ANONYMOUS_USER_ID ? null : actorUid;
    const data = {
      title: game ? game.title : 'Sin título',
      youtubeVideoId: game ? game.youtube_video_id : '',
      // Catálogo completo (botonera + tags solo por import XML, etc.). No usar solo getActiveTagTypes().
      tagTypes: [...state.tagTypes],
      activeButtonboards: state.activeButtonboards,
      games: withCreatedBy(state.games, actorUid),
      clips: withCreatedBy(state.clips, actorUid),
      playlists: withCreatedBy(state.playlists, actorUid),
      playlistItems: state.playlistItems,
      clipFlags: state.clipFlags,
      playlistComments: state.playlistComments,
      activityLog: state.activityLog,
      editKey: state.editKey,
      ownerUid,
      lastEditedByUid: ownerUid,
    };
    const projectId = await FirebaseData.saveProject(state.currentProjectId, data);
    state.currentProjectId = projectId;

    // Update URL with editKey so the owner always has the collab link in their bar
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') !== 'view') {
      const url = FirebaseData.getShareUrl(projectId, null, null, state.editKey);
      window.history.replaceState({}, '', url);
    }

    emit('projectSaved', projectId);
    return projectId;
  }

  async function loadFromCloud(projectId, options = {}) {
    const initialPlaylistId = typeof options.initialPlaylistId === 'string'
      ? options.initialPlaylistId.trim()
      : '';
    const data = await FirebaseData.loadProject(projectId);
    if (!data) return false;

    // If we were browsing a collection, leave that context before loading a project.
    // Otherwise the UI can stay in collection-only mode and hide Analyze.
    const hadActiveCollection = !!state.activeCollection;
    if (hadActiveCollection) {
      state.activeCollection = null;
      state.activeCollectionItemIdx = -1;
      emit('collectionClosed');
    }

    state.localVideoFile = null;
    state.currentProjectId = projectId;
    state.games = data.games || [];
    state.clips = data.clips || [];
    state.playlists = data.playlists || [];
    state.playlistItems = data.playlistItems || {};
    state.clipFlags = data.clipFlags || {};
    state.playlistComments = data.playlistComments || {};
    state.activityLog = data.activityLog || [];
    state.editKey = data.editKey || null;  // restore editKey from Firebase

    // ── Restore / migrate activeButtonboards ──
    if (data.activeButtonboards && data.activeButtonboards.length > 0) {
      state.activeButtonboards = data.activeButtonboards;
      // tagTypes en Firestore = catálogo completo; la botonera es solo la parte visible.
      if (data.tagTypes && data.tagTypes.length > 0) {
        state.tagTypes = [...data.tagTypes];
      } else {
        state.tagTypes = [...(state.activeButtonboards[0].buttons || [])];
      }
    } else if (data.tagTypes && data.tagTypes.length > 0) {
      // Legacy project: wrap existing tagTypes as the first (and only) active board
      state.activeButtonboards = [{
        id: 'migrated-' + Date.now().toString(36),
        name: 'Ventana de código del proyecto',
        buttons: [...data.tagTypes],
      }];
      state.tagTypes = [...data.tagTypes];
    } else {
      state.activeButtonboards = [];
      state.tagTypes = [];
    }

    // Sync DemoData so local mutations work with cloud data
    DemoData.restore(data);
    // Override DemoData tagTypes to match the active board
    if (state.tagTypes.length > 0) DemoData.restoreTagTypes(state.tagTypes);

    // Preserve the currently selected game if it still exists, otherwise fallback to the first one.
    // (app.js init() handles smart selection of the best game on initial load).
    if (state.games.length > 0) {
      if (!state.currentGameId || !state.games.find(g => g.id === state.currentGameId)) {
        state.currentGameId = state.games[0].id;
      }
    }

    state.activeTagFilters = [];
    state.activePlaylistId = initialPlaylistId || null;
    state.filterFlags = [];
    state.currentClipId = null;
    state.currentClipIndex = -1;

    emit('projectLoaded', data);
    emit('gameChanged', getCurrentGame());
    return data;
  }

  // ── XML Import / Export ──
  function importXML(xmlString, offset = 0) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, "application/xml");

      const parserError = xmlDoc.querySelector("parsererror");
      if (parserError) {
        console.error("XML Parsing Error:", parserError.textContent);
        return false;
      }

      // 1. Extract Rows (Tag Colors/Names)
      const rows = xmlDoc.querySelectorAll("ROWS > row");
      const codeToTagMap = {};

      rows.forEach(row => {
        const codeEl = row.querySelector("code");
        if (!codeEl) return;
        const code = codeEl.textContent.trim();

        let existingTag = state.tagTypes.find(t => t.label === code);
        if (!existingTag) {
          existingTag = {
            id: 'tag_' + Date.now() + Math.random().toString(36).substring(2, 9),
            label: code,
            pre_sec: 5,
            post_sec: 5,
            row: 'top', // default
            isHidden: true
          };
          // Rough heuristic for rival vs top based on name (e.g., LEUV vs DARI)
          // But since we can't be sure, default top. 
          state.tagTypes.push(existingTag);
        }
        codeToTagMap[code] = existingTag.id;
      });

      // 2. Extract Instances (Clips)
      const instances = xmlDoc.querySelectorAll("ALL_INSTANCES > instance");
      let clipCount = 0;

      instances.forEach(inst => {
        const startEl = inst.querySelector("start");
        const endEl = inst.querySelector("end");
        const codeEl = inst.querySelector("code");

        if (!startEl || !endEl || !codeEl) return;

        const code = codeEl.textContent.trim();
        let tagId = codeToTagMap[code];

        // If instance has a code not defined in rows, create tag dynamically
        if (!tagId) {
          let existingTag = state.tagTypes.find(t => t.label === code);
          if (!existingTag) {
            existingTag = {
              id: 'tag_' + Date.now() + Math.random().toString(36).substring(2, 9),
              label: code,
              pre_sec: 5,
              post_sec: 5,
              row: 'top',
              isHidden: true
            };
            state.tagTypes.push(existingTag);
          }
          codeToTagMap[code] = existingTag.id;
          tagId = existingTag.id;
        }

        const startSec = (parseFloat(startEl.textContent) || 0) + offset;
        const endSec = (parseFloat(endEl.textContent) || 0) + offset;

        // Add clip
        const clip = {
          id: 'clip_' + Date.now() + Math.random().toString(36).substring(2, 9),
          game_id: state.currentGameId,
          tag_type_id: tagId,
          t_sec: startSec,
          start_sec: startSec,
          end_sec: endSec
        };
        state.clips.push(clip);
        clipCount++;
      });

      emit('tagTypesUpdated');
      emit('clipsUpdated');
      // Add trace to activity log
      addActivity('xml_import', { count: clipCount });

      return clipCount;

    } catch (e) {
      console.error('Error importing XML:', e);
      return false;
    }
  }

  function exportXML() {
    const gameId = state.currentGameId;
    if (!gameId) return null;

    // Filter clips for current game
    const gameClips = state.clips.filter(c => c.game_id === gameId);

    // Use ExportManager for a unified, professional format
    return ExportManager.generateXML({
      clips: gameClips,
      tagTypes: state.tagTypes,
      clipFlags: state.clipFlags,
      playlistComments: state.playlistComments
    });
  }

  function exportProjectData() {
    const game = getCurrentGame();
    if (!game) return null;

    return {
      version: '1.0',
      timestamp: new Date().toISOString(),
      game: { ...game, local_video_url: null }, // Don't export the blob URL
      clips: [...state.clips],
      playlists: [...state.playlists],
      playlistItems: { ...state.playlistItems },
      clipFlags: { ...state.clipFlags },
      playlistComments: { ...state.playlistComments },
      tagTypes: [...state.tagTypes]
    };
  }

  function importProjectData(data) {
    if (!data || !data.game) throw new Error('Formato de proyecto inválido');

    let gameToImport = { ...data.game };
    let clipsToImport = [...(data.clips || [])];
    let playlistsToImport = [...(data.playlists || [])];
    let playlistItemsToImport = { ...(data.playlistItems || {}) };
    let clipFlagsToImport = { ...(data.clipFlags || {}) };
    let playlistCommentsToImport = { ...(data.playlistComments || {}) };
    const actorUid = getActorUidForOwnership();

    // Collision check: if project already exists, create a copy with new IDs
    const exists = state.games.some(g => g.id === gameToImport.id);
    if (exists) {
      const newGameId = 'imp-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 5);
      const oldGameId = gameToImport.id;

      gameToImport.id = newGameId;
      gameToImport.title += ' (Importado)';

      // Map old IDs to new IDs for clips and playlists
      const clipIdMap = {};
      clipsToImport = clipsToImport.map(c => {
        const newClipId = 'clip-' + Math.random().toString(36).substr(2, 9);
        clipIdMap[c.id] = newClipId;
        return { ...c, id: newClipId, game_id: newGameId };
      });

      const plIdMap = {};
      playlistsToImport = playlistsToImport.map(p => {
        const newPlId = 'pl-' + Math.random().toString(36).substr(2, 9);
        plIdMap[p.id] = newPlId;
        return { ...p, id: newPlId, game_id: newGameId };
      });

      // Remap playlist items
      const newPlaylistItems = {};
      Object.entries(playlistItemsToImport).forEach(([oldPlId, clipIds]) => {
        const newPlId = plIdMap[oldPlId];
        if (newPlId) {
          newPlaylistItems[newPlId] = clipIds.map(oldClipId => clipIdMap[oldClipId]).filter(id => id);
        }
      });
      playlistItemsToImport = newPlaylistItems;

      // Remap flags
      const newClipFlags = {};
      Object.entries(clipFlagsToImport).forEach(([oldClipId, flags]) => {
        const newClipId = clipIdMap[oldClipId];
        if (newClipId) newClipFlags[newClipId] = flags;
      });
      clipFlagsToImport = newClipFlags;

      // Remap comments
      const newPlaylistComments = {};
      Object.entries(playlistCommentsToImport).forEach(([oldKey, comments]) => {
        const [oldPlId, oldClipId] = oldKey.split('::');
        const newPlId = plIdMap[oldPlId];
        const newClipId = clipIdMap[oldClipId];
        if (newPlId && newClipId) {
          newPlaylistComments[`${newPlId}::${newClipId}`] = comments;
        }
      });
      playlistCommentsToImport = newPlaylistComments;
    }

    // Imported JSONs from older versions may carry demo ownership metadata.
    // Normalize ownership so saved projects are attributed to the authenticated user.
    if (actorUid) {
      gameToImport.created_by = actorUid;
      clipsToImport = clipsToImport.map((c) => ({ ...c, created_by: actorUid }));
      playlistsToImport = playlistsToImport.map((p) => ({ ...p, created_by: actorUid }));
    }

    // Clear current state first
    clearProject();

    // Sync with DemoData (persistence simulation)
    // We need to transform the data back to what DemoData.restore expects
    const demoFormat = {
      games: [gameToImport],
      clips: clipsToImport,
      playlists: playlistsToImport,
      playlistItems: {},
      clipFlags: {}
    };
    
    // Transform playlistItems from {plId: [clipIds]} to [{playlist_id, clip_id}]
    Object.entries(playlistItemsToImport).forEach(([plId, clipIds]) => {
      demoFormat.playlistItems[plId] = clipIds; 
    });
    
    // Transform clipFlags from {clipId: [flags]} to {clipId: [{userId, flag}]}
    Object.entries(clipFlagsToImport).forEach(([clipId, flags]) => {
      demoFormat.clipFlags[clipId] = flags;
    });

    DemoData.restore(demoFormat);

    // Import into AppState
    state.games = DemoData.getGames();
    state.currentGameId = gameToImport.id;
    state.clips = clipsToImport;
    state.playlists = playlistsToImport;
    state.playlistItems = playlistItemsToImport;
    state.clipFlags = clipFlagsToImport;
    state.playlistComments = playlistCommentsToImport;

    // Same rules as loadFromCloud: if activeButtonboards exist, tagTypes come from the first board's buttons.
    // Otherwise legacy tagTypes only, or empty — never leave stale state.tagTypes from a previous session.
    if (data.activeButtonboards && data.activeButtonboards.length > 0) {
      state.activeButtonboards = data.activeButtonboards;
      state.tagTypes = [...(state.activeButtonboards[0].buttons || [])];
    } else if (data.tagTypes && data.tagTypes.length > 0) {
      state.activeButtonboards = [{
        id: 'migrated-' + Date.now().toString(36),
        name: 'Ventana de código del proyecto',
        buttons: [...data.tagTypes],
      }];
      state.tagTypes = [...data.tagTypes];
    } else {
      state.activeButtonboards = [];
      state.tagTypes = [];
    }

    if (state.tagTypes.length > 0) {
      DemoData.restoreTagTypes(state.tagTypes);
    }

    emit('tagTypesUpdated', getActiveTagTypes());
    emit('gameChanged', gameToImport);
    return gameToImport;
  }

  return {
    on, off, get, set: (k, v) => { state[k] = v; },
    getCurrentGame, getLocalVideoFile, setLocalVideoFile, getCurrentClip, getTagType, getTagTypesForFilter, getFilteredClips, getClipUserFlags,
    setMode, setCurrentGame, setCurrentClip,
    addGame, addClip, updateClipBounds, updateClipAbsoluteBounds, deleteClip,
    addPlaylist, addClipToPlaylist, removeClipFromPlaylist, renamePlaylist, deletePlaylist, reorderPlaylist,
    toggleFlag, toggleTagFilter, removeTagFilter, clearTagFilters, clearAllFilters,
    setPlaylistFilter, clearPlaylistFilter, toggleFilterFlag, clearFilterFlags,
    addTagType, updateTagType, deleteTagType,
    setActiveButtonboards,
    togglePanel, toggleFocusView, navigateClip,
    init, setFeatureFlags, hasFeature, setAuthenticatedUser,
    clearProject, saveToCloud, loadFromCloud, importXML, exportXML,
    exportProjectData, importProjectData,
    addComment, getComments, removeComment, getClipNumber, getPreferredChatName,
    addActivity, getActivityLog,
    openCollection, closeCollection, setCollectionItemIndex, navigateCollectionItem,
    removeCollectionItem, reorderCollectionItems,
  };
})();
