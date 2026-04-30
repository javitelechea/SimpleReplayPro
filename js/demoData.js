/* ═══════════════════════════════════════════
   SimpleReplay — Demo Data (In-Memory)
   Replaces Supabase for local development
   ═══════════════════════════════════════════ */

export const DemoData = (() => {
    let _nextId = 1;
    function uuid() { return 'demo-' + (Date.now().toString(36)) + '-' + (_nextId++); }

    // ── Tag Types (seeded) ──
    // row: 'top' = own team, 'bottom' = rival (EC = equipo contrario)
    let tagTypes = [
        { id: 'tag-start', key: 'start', label: 'Start', row: 'top', pre_sec: 0, post_sec: 1, order: 0 },
        { id: 'tag-salida', key: 'salida', label: 'Salida', row: 'top', pre_sec: 3, post_sec: 8, order: 1 },
        { id: 'tag-ataque', key: 'ataque', label: 'Ataque', row: 'top', pre_sec: 3, post_sec: 8, order: 2 },
        { id: 'tag-area', key: 'area', label: 'Área', row: 'top', pre_sec: 3, post_sec: 8, order: 3 },
        { id: 'tag-contragolpe', key: 'contragolpe', label: 'Contragolpe', row: 'top', pre_sec: 3, post_sec: 10, order: 4 },
        { id: 'tag-cc-at', key: 'cc_at', label: 'CC AT', row: 'top', pre_sec: 3, post_sec: 8, order: 5 },
        { id: 'tag-gol', key: 'gol', label: 'Gol', row: 'top', pre_sec: 5, post_sec: 10, order: 6 },
        { id: 'tag-bloqueo', key: 'bloqueo', label: 'Bloqueo', row: 'bottom', pre_sec: 3, post_sec: 8, order: 7 },
        { id: 'tag-defensa', key: 'defensa', label: 'Defensa', row: 'bottom', pre_sec: 3, post_sec: 8, order: 8 },
        { id: 'tag-area-ec', key: 'area_ec', label: 'Área EC', row: 'bottom', pre_sec: 3, post_sec: 8, order: 9 },
        { id: 'tag-contragolpe-ec', key: 'contragolpe_ec', label: 'Contragolpe EC', row: 'bottom', pre_sec: 3, post_sec: 10, order: 10 },
        { id: 'tag-cc-def', key: 'cc_def', label: 'CC DEF', row: 'bottom', pre_sec: 3, post_sec: 8, order: 11 },
        { id: 'tag-gol-ec', key: 'gol_ec', label: 'Gol EC', row: 'bottom', pre_sec: 5, post_sec: 10, order: 12 },
    ];

    // ── In-memory stores ──
    let games = [];
    let clips = [];
    let playlists = [];
    let playlistItems = [];   // { id, playlist_id, clip_id, order }
    let clipFlags = [];       // { id, clip_id, user_id, flag, created_at }

    // ── Seed demo data ──
    function seed() {
        // Demo game
        const game1 = {
            id: 'game-demo-1',
            title: '231029 Argentina - EEUU',
            youtube_video_id: 'ZabnNjou_PI',
            created_by: 'demo-user-001',
            created_at: new Date().toISOString()
        };
        games.push(game1);

        // Demo clips
        const demoClips = [
            { tag: 'tag-salida', t: 501 },
            { tag: 'tag-ataque', t: 522 },
            { tag: 'tag-area-ec', t: 758 },
            { tag: 'tag-bloqueo', t: 557 },
            { tag: 'tag-gol', t: 1567 },
            { tag: 'tag-contragolpe-ec', t: 654 },
            { tag: 'tag-salida', t: 575 },
            { tag: 'tag-cc-at', t: 970 },
            { tag: 'tag-defensa', t: 688 },
            { tag: 'tag-area', t: 601 },
        ];

        demoClips.forEach(dc => {
            const tag = tagTypes.find(t => t.id === dc.tag);
            clips.push({
                id: uuid(),
                game_id: game1.id,
                tag_type_id: dc.tag,
                t_sec: dc.t,
                start_sec: Math.max(0, dc.t - tag.pre_sec),
                end_sec: dc.t + tag.post_sec,
                created_by: 'demo-user-001',
                created_at: new Date().toISOString()
            });
        });

        // Demo flags on some clips
        clipFlags.push({ id: uuid(), clip_id: clips[0].id, user_id: 'demo-user-001', flag: 'bueno', created_at: new Date().toISOString() });
        clipFlags.push({ id: uuid(), clip_id: clips[1].id, user_id: 'demo-user-001', flag: 'acorregir', created_at: new Date().toISOString() });
        clipFlags.push({ id: uuid(), clip_id: clips[4].id, user_id: 'demo-user-001', flag: 'importante', created_at: new Date().toISOString() });
        clipFlags.push({ id: uuid(), clip_id: clips[4].id, user_id: 'demo-user-001', flag: 'bueno', created_at: new Date().toISOString() });

        // Demo playlist
        const pl1 = {
            id: 'pl-demo-1',
            game_id: game1.id,
            name: 'Mejores jugadas',
            created_by: 'demo-user-001',
            created_at: new Date().toISOString()
        };
        playlists.push(pl1);
        playlistItems.push({ id: uuid(), playlist_id: pl1.id, clip_id: clips[0].id, order: 0 });
        playlistItems.push({ id: uuid(), playlist_id: pl1.id, clip_id: clips[4].id, order: 1 });
    }

    // ── API ──
    function getTagTypes() { return [...tagTypes]; }

    function getGames() { return [...games]; }

    function createGame(title, youtubeVideoId, localVideoUrl = null, createdBy) {
        const g = {
            id: uuid(),
            title,
            youtube_video_id: youtubeVideoId,
            local_video_url: localVideoUrl,
            created_by: createdBy,
            created_at: new Date().toISOString()
        };
        games.push(g);
        return g;
    }

    function getClipsForGame(gameId) {
        return clips.filter(c => c.game_id === gameId).sort((a, b) => a.t_sec - b.t_sec);
    }

    function createClip(gameId, tagTypeId, tSec, startSec, endSec, createdBy) {
        const c = {
            id: uuid(),
            game_id: gameId,
            tag_type_id: tagTypeId,
            t_sec: tSec,
            start_sec: startSec,
            end_sec: endSec,
            created_by: createdBy,
            created_at: new Date().toISOString()
        };
        clips.push(c);
        return c;
    }

    function updateClip(clipId, fields) {
        const c = clips.find(cl => cl.id === clipId);
        if (c) Object.assign(c, fields);
    }

    function deleteClip(clipId) {
        clips = clips.filter(c => c.id !== clipId);
        playlistItems = playlistItems.filter(pi => pi.clip_id !== clipId);
        clipFlags = clipFlags.filter(cf => cf.clip_id !== clipId);
    }

    function getPlaylistsForGame(gameId) {
        return playlists.filter(p => p.game_id === gameId);
    }

    function createPlaylist(gameId, name, createdBy) {
        const p = {
            id: uuid(),
            game_id: gameId,
            name,
            created_by: createdBy,
            created_at: new Date().toISOString()
        };
        playlists.push(p);
        return p;
    }

    function getPlaylistItems(playlistId) {
        return playlistItems
            .filter(pi => pi.playlist_id === playlistId)
            .sort((a, b) => a.order - b.order)
            .map(pi => pi.clip_id);
    }

    function addClipToPlaylist(playlistId, clipId) {
        const existing = playlistItems.find(pi => pi.playlist_id === playlistId && pi.clip_id === clipId);
        if (existing) return;
        const maxOrder = playlistItems
            .filter(pi => pi.playlist_id === playlistId)
            .reduce((m, pi) => Math.max(m, pi.order), -1);
        playlistItems.push({
            id: uuid(),
            playlist_id: playlistId,
            clip_id: clipId,
            order: maxOrder + 1
        });
    }

    function removeClipFromPlaylist(playlistId, clipId) {
        const idx = playlistItems.findIndex(pi => pi.playlist_id === playlistId && pi.clip_id === clipId);
        if (idx >= 0) playlistItems.splice(idx, 1);
    }

    function getClipFlags(clipId) {
        return clipFlags
            .filter(cf => cf.clip_id === clipId)
            .map(cf => ({ flag: cf.flag, userId: cf.user_id }));
    }

    function addFlag(clipId, userId, flag) {
        const exists = clipFlags.find(cf => cf.clip_id === clipId && cf.user_id === userId && cf.flag === flag);
        if (exists) return;
        clipFlags.push({
            id: uuid(),
            clip_id: clipId,
            user_id: userId,
            flag,
            created_at: new Date().toISOString()
        });
    }

    function removeFlag(clipId, userId, flag) {
        clipFlags = clipFlags.filter(cf =>
            !(cf.clip_id === clipId && cf.user_id === userId && cf.flag === flag)
        );
    }

    // ── DB sync for cloud projects ──
    function clear() {
        games = [];
        clips = [];
        playlists = [];
        playlistItems = [];
        clipFlags = [];
    }

    function restore(data) {
        tagTypes = data.tagTypes || [];
        games = data.games || [];
        clips = data.clips || [];
        playlists = data.playlists || [];
        playlistItems = [];
        if (data.playlistItems) {
            Object.keys(data.playlistItems).forEach(plId => {
                data.playlistItems[plId].forEach((cId, idx) => {
                    playlistItems.push({ id: uuid(), playlist_id: plId, clip_id: cId, order: idx });
                });
            });
        }
        clipFlags = [];
        if (data.clipFlags) {
            Object.keys(data.clipFlags).forEach(cId => {
                data.clipFlags[cId].forEach(f => {
                    clipFlags.push({ id: uuid(), clip_id: cId, user_id: f.userId, flag: f.flag, created_at: new Date().toISOString() });
                });
            });
        }
    }

    // Tag CRUD
    function createTagType(data) {
        const maxOrder = tagTypes.reduce((m, t) => Math.max(m, t.order || 0), 0);
        const tag = {
            id: data.id || 'tag-' + data.key,
            key: data.key,
            label: data.label,
            row: data.row || 'top',
            pre_sec: data.pre_sec || 3,
            post_sec: data.post_sec || 8,
            captureMode: data.captureMode === 'manual' ? 'manual' : 'fixed',
            order: data.order || maxOrder + 1
        };
        tagTypes.push(tag);
        return tag;
    }

    function updateTagType(id, changes) {
        const tag = tagTypes.find(t => t.id === id);
        if (tag) Object.assign(tag, changes);
    }

    function deleteTagType(id) {
        tagTypes = tagTypes.filter(t => t.id !== id);
    }

    // Replaces the in-memory tagTypes array with the provided list.
    // Used by AppState to sync DemoData when a buttonboard is loaded.
    function restoreTagTypes(newTagTypes) {
        tagTypes = (newTagTypes || []).map(t => ({ ...t }));
    }

    function deletePlaylist(id) {
        playlists = playlists.filter(p => p.id !== id);
        delete playlistItems[id];
    }

    // Seed on load
    seed();

    return {
        getTagTypes, getGames, createGame,
        getClipsForGame, createClip, updateClip, deleteClip,
        getPlaylistsForGame, createPlaylist, getPlaylistItems, addClipToPlaylist, removeClipFromPlaylist, deletePlaylist,
        getClipFlags, addFlag, removeFlag,
        createTagType, updateTagType, deleteTagType, restoreTagTypes,
        clear, restore
    };
})();
