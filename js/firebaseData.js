import {
    doc,
    getDoc,
    setDoc,
    collection,
    addDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './firebaseClient.js';

export const FirebaseData = (() => {
    const USER_FOLDERS_DOC_VERSION = 1;

    async function saveProject(projectId, data) {
        const payload = {
            title: data.title || 'Sin título',
            youtubeVideoId: data.youtubeVideoId || '',
            tagTypes: data.tagTypes || [],
            activeButtonboards: data.activeButtonboards || [],
            games: data.games || [],
            clips: data.clips || [],
            playlists: data.playlists || [],
            playlistItems: data.playlistItems || {},
            clipFlags: data.clipFlags || {},
            playlistComments: data.playlistComments || {},
            activityLog: data.activityLog || [],
            updatedAt: serverTimestamp(),
        };

        if (data.editKey) payload.editKey = data.editKey;

        const timeout = (ms) =>
            new Promise((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                'Tiempo agotado. Verificá tu conexión a internet y que Firestore esté activo.'
                            )
                        ),
                    ms
                )
            );

        const doSave = async () => {
            if (projectId) {
                await setDoc(doc(db, 'projects', projectId), payload, { merge: true });
                return projectId;
            }
            const withCreated = { ...payload, createdAt: serverTimestamp() };
            const ref = await addDoc(collection(db, 'projects'), withCreated);
            return ref.id;
        };

        return Promise.race([doSave(), timeout(15000)]);
    }

    async function loadProject(projectId) {
        try {
            const snap = await getDoc(doc(db, 'projects', projectId));
            if (!snap.exists()) return null;
            return { id: snap.id, ...snap.data() };
        } catch (err) {
            console.error('Error loading project:', err);
            return null;
        }
    }

    function getShareUrl(projectId, gameId = null, playlistId = null, editKey = null) {
        const baseUrl = window.location.href.split('?')[0].split('#')[0];
        const params = new URLSearchParams();
        params.set('project', projectId);
        if (gameId) params.set('game', gameId);
        if (playlistId) params.set('playlist', playlistId);
        if (editKey) params.set('editKey', editKey);
        return baseUrl + '?' + params.toString();
    }

    function getPlaylistIdFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('playlist') || null;
    }

    function getGameIdFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('game') || null;
    }

    function getProjectIdFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('project') || null;
    }

    function getEditKeyFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('editKey') || null;
    }

    function getLocalProjects() {
        try {
            const stored = localStorage.getItem('sr_my_projects');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    }

    function addProjectLocally(projectId, isShared = false) {
        const ids = getLocalProjects();
        const exists = ids.find((p) => (typeof p === 'string' ? p === projectId : p.id === projectId));
        if (!exists) {
            ids.push({ id: projectId, shared: isShared });
            localStorage.setItem('sr_my_projects', JSON.stringify(ids));
        }
    }

    function removeProjectLocally(projectId) {
        let ids = getLocalProjects();
        ids = ids.filter((p) => (typeof p === 'string' ? p : p.id) !== projectId);
        localStorage.setItem('sr_my_projects', JSON.stringify(ids));
    }

    async function listProjects() {
        try {
            const stored = getLocalProjects();
            if (stored.length === 0) return [];

            const projectIds = stored.map((p) => (typeof p === 'string' ? { id: p, shared: false } : p));

            const promises = projectIds.map((p) => loadProject(p.id).then((data) => ({ data, shared: p.shared })));
            const results = await Promise.all(promises);
            return results
                .filter((res) => res.data !== null)
                .map((res) => ({
                    id: res.data.id,
                    title: res.data.title || 'Sin título',
                    updatedAt: res.data.updatedAt?.toDate?.() || null,
                    youtubeVideoId: res.data.youtubeVideoId || '',
                    isShared: res.shared,
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        } catch (err) {
            console.error('Error listing projects:', err);
            return [];
        }
    }

    async function loadUserProjectFolders(uid) {
        if (!uid) return { folders: [], projectMap: {} };
        try {
            // Primary storage (safer with existing rules): users/{uid}
            const userSnap = await getDoc(doc(db, 'users', uid));
            if (userSnap.exists()) {
                const u = userSnap.data() || {};
                const folders = Array.isArray(u.projectFolders) ? u.projectFolders : [];
                const projectMap = u.projectFolderMap && typeof u.projectFolderMap === 'object' ? u.projectFolderMap : {};
                if (folders.length || Object.keys(projectMap).length) {
                    return { folders, projectMap };
                }
            }

            // Backward-compatible fallback (if previously saved there)
            const legacySnap = await getDoc(doc(db, 'userProjectFolders', uid));
            if (!legacySnap.exists()) return { folders: [], projectMap: {} };
            const data = legacySnap.data() || {};
            return {
                folders: Array.isArray(data.folders) ? data.folders : [],
                projectMap: data.projectMap && typeof data.projectMap === 'object' ? data.projectMap : {},
            };
        } catch (err) {
            console.error('Error loading user folders:', err);
            return { folders: [], projectMap: {} };
        }
    }

    async function saveUserProjectFolders(uid, payload) {
        if (!uid) throw new Error('Usuario no autenticado');
        const folders = Array.isArray(payload?.folders) ? payload.folders : [];
        const projectMap = payload?.projectMap && typeof payload.projectMap === 'object' ? payload.projectMap : {};
        // Write inside users/{uid} to align with existing auth/permissions.
        await setDoc(doc(db, 'users', uid), {
            version: USER_FOLDERS_DOC_VERSION,
            projectFolders: folders,
            projectFolderMap: projectMap,
            updatedAt: serverTimestamp(),
        }, { merge: true });
    }

    return {
        saveProject,
        loadProject,
        listProjects,
        getShareUrl,
        getProjectIdFromUrl,
        getEditKeyFromUrl,
        getGameIdFromUrl,
        getPlaylistIdFromUrl,
        addProjectLocally,
        removeProjectLocally,
        loadUserProjectFolders,
        saveUserProjectFolders,
    };
})();
