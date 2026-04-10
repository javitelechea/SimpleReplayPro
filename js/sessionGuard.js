import { doc, onSnapshot, setDoc, serverTimestamp, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './firebaseClient.js';

const DEVICE_ID_KEY = 'sr_device_id_v1';
const SESSION_ID_KEY = 'sr_session_id_v1';
const HEARTBEAT_MS = 20000;

function _rand() {
    return Math.random().toString(36).slice(2, 10);
}

function _ensureDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = `dev_${Date.now().toString(36)}_${_rand()}`;
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
}

function _ensureSessionId() {
    let id = localStorage.getItem(SESSION_ID_KEY);
    if (!id) {
        id = `ses_${Date.now().toString(36)}_${_rand()}`;
        localStorage.setItem(SESSION_ID_KEY, id);
    }
    return id;
}

export function createSessionGuard({ onConflict, onError } = {}) {
    const deviceId = _ensureDeviceId();
    const sessionId = _ensureSessionId();
    let uid = null;
    let unsub = null;
    let timer = null;
    let started = false;
    let conflictRaised = false;

    const userRef = () => (uid ? doc(db, 'users', uid) : null);

    async function writeHeartbeat() {
        if (!uid) return;
        await setDoc(userRef(), {
            activeSessionId: sessionId,
            activeSessionDeviceId: deviceId,
            activeSessionUa: navigator.userAgent || '',
            activeSessionAt: serverTimestamp(),
        }, { merge: true });
    }

    async function start(nextUid) {
        if (!nextUid) return;
        if (started && uid === nextUid) return;
        stop(false);
        uid = nextUid;
        started = true;
        conflictRaised = false;

        await writeHeartbeat();
        timer = setInterval(() => {
            writeHeartbeat().catch((e) => onError && onError(e));
        }, HEARTBEAT_MS);

        unsub = onSnapshot(userRef(), (snap) => {
            if (!started || !snap.exists() || conflictRaised) return;
            const data = snap.data() || {};
            const activeSessionId = data.activeSessionId || '';
            if (activeSessionId && activeSessionId !== sessionId) {
                conflictRaised = true;
                onConflict && onConflict({
                    sessionId,
                    activeSessionId,
                    activeDeviceId: data.activeSessionDeviceId || null,
                });
            }
        }, (e) => {
            onError && onError(e);
        });
    }

    async function stop(clearIfOwned = true) {
        if (timer) clearInterval(timer);
        timer = null;
        if (unsub) unsub();
        unsub = null;
        const prevUid = uid;
        uid = null;
        started = false;
        conflictRaised = false;
        if (!clearIfOwned || !prevUid) return;
        try {
            const ref = doc(db, 'users', prevUid);
            const snap = await getDoc(ref);
            if (!snap.exists()) return;
            const data = snap.data() || {};
            if ((data.activeSessionId || '') !== sessionId) return;
            await setDoc(ref, {
                activeSessionId: '',
                activeSessionDeviceId: '',
                activeSessionAt: serverTimestamp(),
            }, { merge: true });
        } catch (e) {
            onError && onError(e);
        }
    }

    return {
        start,
        stop,
        sessionId,
        deviceId,
    };
}

