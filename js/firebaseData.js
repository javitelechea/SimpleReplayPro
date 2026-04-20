import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    collection,
    addDoc,
    query,
    where,
    getDocs,
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
        if (data.lastEditedByUid) payload.lastEditedByUid = data.lastEditedByUid;
        if (!projectId && data.ownerUid) payload.ownerUid = data.ownerUid;

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

    async function markProjectOpened(projectId) {
        if (!projectId) return;
        try {
            await updateDoc(doc(db, 'projects', projectId), {
                lastOpenedAt: serverTimestamp(),
            });
        } catch (err) {
            // Don't block UX if this metadata update fails.
            console.warn('Could not update lastOpenedAt:', err);
        }
    }

    async function deleteProjectCloud(projectId) {
        if (!projectId) throw new Error('Proyecto inválido');
        await deleteDoc(doc(db, 'projects', projectId));
        removeProjectLocally(projectId);
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

    function mapDocToListRow(docSnap, isShared) {
        const data = docSnap.data() || {};
        return {
            id: docSnap.id,
            title: data.title || 'Sin título',
            updatedAt: data.updatedAt?.toDate?.() || null,
            lastOpenedAt: data.lastOpenedAt?.toDate?.() || null,
            ownerUid: data.ownerUid || '',
            youtubeVideoId: data.youtubeVideoId || '',
            isShared,
        };
    }

    /**
     * Lista proyectos: propios desde Firestore (ownerUid) + índice local (sr_my_projects).
     * Así los proyectos aparecen en un navegador nuevo sin depender solo de localStorage.
     * authUid: Firebase uid del usuario logueado; si es null, solo se usa la lista local.
     */
    async function listProjects(authUid = null) {
        try {
            const stored = getLocalProjects();
            const normalized = stored.map((p) =>
                typeof p === 'string' ? { id: p, shared: false } : { id: p.id, shared: !!p.shared }
            );

            const sharedRefs = normalized.filter((p) => p.shared);
            const localOwnedIds = new Set(normalized.filter((p) => !p.shared).map((p) => p.id));

            const rows = [];
            const seenIds = new Set();
            let cloudOwnedIds = new Set();

            if (authUid) {
                try {
                    const q = query(collection(db, 'projects'), where('ownerUid', '==', authUid));
                    const snap = await getDocs(q);
                    cloudOwnedIds = new Set(snap.docs.map((d) => d.id));
                    snap.docs.forEach((d) => {
                        const row = mapDocToListRow(d, false);
                        rows.push(row);
                        seenIds.add(row.id);
                    });
                } catch (err) {
                    console.error('Error listando proyectos propios en Firestore:', err);
                }
            }

            // Propios solo locales (p. ej. legacy sin ownerUid en documento): sigue haciendo falta getDoc
            const legacyOwnedLoads = [...localOwnedIds].filter((id) => !seenIds.has(id)).map((id) =>
                loadProject(id).then((data) => ({ data, shared: false }))
            );

            // Compartidos: solo en localStorage; no entran en la query por ownerUid
            const sharedLoads = sharedRefs
                .filter((p) => !seenIds.has(p.id))
                .map((p) => loadProject(p.id).then((data) => ({ data, shared: true })));

            const extra = await Promise.all([...legacyOwnedLoads, ...sharedLoads]);
            extra.forEach((res) => {
                if (!res.data) return;
                rows.push({
                    id: res.data.id,
                    title: res.data.title || 'Sin título',
                    updatedAt: res.data.updatedAt?.toDate?.() || null,
                    lastOpenedAt: res.data.lastOpenedAt?.toDate?.() || null,
                    ownerUid: res.data.ownerUid || '',
                    youtubeVideoId: res.data.youtubeVideoId || '',
                    isShared: res.shared,
                });
            });

            // Mantener el índice local alineado con la nube (sin borrar entradas "compartidas")
            if (authUid && cloudOwnedIds.size > 0) {
                cloudOwnedIds.forEach((id) => addProjectLocally(id, false));
            }

            return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
        markProjectOpened,
        deleteProjectCloud,
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
