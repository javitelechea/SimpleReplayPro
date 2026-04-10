import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db } from './firebaseClient.js';

async function ensureUserDoc(user) {
    if (!user) return;
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) return;
    await setDoc(ref, {
        email: user.email || '',
        name: user.displayName || '',
        plan: 'free',
        createdAt: serverTimestamp(),
    });
}

export async function loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    const { user } = await signInWithPopup(auth, provider);
    await ensureUserDoc(user);
    return user;
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

export function waitForAuthReady() {
    return auth.authStateReady();
}
