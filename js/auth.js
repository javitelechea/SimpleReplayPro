import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db } from './firebaseClient.js';

const LAST_SEEN_UPDATE_MS = 6 * 60 * 60 * 1000;
const SURVISION_ENSURE_URL = 'https://us-central1-survision-fa8cc.cloudfunctions.net/ensureUserFromPartner';
const SURVISION_PARTNER_KEY = 'IEbalb2ioebsszXBDDtYE_ADkJcjMmSeiKzm4KLAgnY';

async function syncToSurvision(user) {
    if (!user?.email) return;
    try {
        await fetch(SURVISION_ENSURE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SURVISION_PARTNER_KEY },
            body: JSON.stringify({
                email: user.email,
                name: user.displayName || '',
                photoURL: user.photoURL || '',
            }),
        });
    } catch (e) {
        console.warn('syncToSurvision: failed (non-blocking)', e);
    }
}

async function ensureUserDoc(user) {
    if (!user) return;
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
        await setDoc(ref, {
            email: user.email || '',
            name: user.displayName || '',
            plan: 'free',
            createdAt: serverTimestamp(),
            lastSeenAt: serverTimestamp(),
        });
        syncToSurvision(user);
        return;
    }

    const data = snap.data() || {};
    const lastSeenMs = data.lastSeenAt?.toMillis?.() || 0;
    const shouldUpdateLastSeen = !lastSeenMs || (Date.now() - lastSeenMs) >= LAST_SEEN_UPDATE_MS;
    const identityChanged = (data.email || '') !== (user.email || '') || (data.name || '') !== (user.displayName || '');
    if (!shouldUpdateLastSeen && !identityChanged) return;

    await setDoc(ref, {
        email: user.email || '',
        name: user.displayName || '',
        lastSeenAt: serverTimestamp(),
    }, { merge: true });

    if (identityChanged) syncToSurvision(user);
}

export async function loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    try {
        const { user } = await signInWithPopup(auth, provider);
        await ensureUserDoc(user);
        return user;
    } catch (e) {
        if (
            e?.code === 'auth/popup-blocked' ||
            e?.code === 'auth/cancelled-popup-request' ||
            String(e?.message || '').includes('Cross-Origin-Opener-Policy')
        ) {
            await signInWithRedirect(auth, provider);
            return null;
        }
        throw e;
    }
}

export async function handleRedirectLoginResult() {
    const result = await getRedirectResult(auth);
    if (result?.user) {
        await ensureUserDoc(result.user);
        return result.user;
    }
    return null;
}

export function logout() {
    return signOut(auth);
}

export function getCurrentUser() {
    return auth.currentUser;
}

/** @returns {() => void} unsubscribe */
export function onAuthChange(callback) {
    return onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                await ensureUserDoc(user);
            } catch (e) {
                console.error('ensureUserDoc:', e);
            }
        }
        callback(user);
    });
}

export async function getUserDoc(uid) {
    if (!uid) return null;
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
}

export async function setLastProjectForUser(uid, projectId) {
    if (!uid || !projectId) return;
    await setDoc(doc(db, 'users', uid), {
        lastProjectId: projectId,
        lastProjectOpenedAt: serverTimestamp(),
    }, { merge: true });
}

export function waitForAuthReady() {
    return auth.authStateReady();
}
