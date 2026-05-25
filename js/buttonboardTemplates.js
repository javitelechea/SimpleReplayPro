/* ═══════════════════════════════════════════
   SimpleReplay — Buttonboard Templates
   Firebase CRUD for system & user templates
   ═══════════════════════════════════════════ */

import {
    collection, getDocs, doc, setDoc, addDoc, deleteDoc,
    query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './firebaseClient.js';
import { getBuiltinTagLabel, t } from './i18n.js';

// ── Fallback: built-in default used when Firebase has no system templates ──
function _resolvedBuiltinButtons() {
    return [
        { id: 'tag-start',          key: 'start',           label: getBuiltinTagLabel('start'),          row: 'top',    pre_sec: 0,  post_sec: 1,  order: 0  },
        { id: 'tag-salida',         key: 'salida',          label: getBuiltinTagLabel('salida'),         row: 'top',    pre_sec: 3,  post_sec: 10, order: 1  },
        { id: 'tag-ataque',         key: 'ataque',          label: getBuiltinTagLabel('ataque'),         row: 'top',    pre_sec: 3,  post_sec: 8,  order: 2  },
        { id: 'tag-area',           key: 'area',            label: getBuiltinTagLabel('area'),           row: 'top',    pre_sec: 6,  post_sec: 4,  order: 3  },
        { id: 'tag-contragolpe',    key: 'contragolpe',     label: getBuiltinTagLabel('contragolpe'),    row: 'top',    pre_sec: 5,  post_sec: 7,  order: 4  },
        { id: 'tag-cc-at',          key: 'cc_at',           label: getBuiltinTagLabel('cc_at'),          row: 'top',    pre_sec: 3,  post_sec: 8,  order: 5  },
        { id: 'tag-gol',            key: 'gol',             label: getBuiltinTagLabel('gol'),            row: 'top',    pre_sec: 10, post_sec: 3,  order: 6  },
        { id: 'tag-bloqueo',        key: 'bloqueo',         label: getBuiltinTagLabel('bloqueo'),        row: 'bottom', pre_sec: 3,  post_sec: 10, order: 7  },
        { id: 'tag-defensa',        key: 'defensa',         label: getBuiltinTagLabel('defensa'),        row: 'bottom', pre_sec: 3,  post_sec: 8,  order: 8  },
        { id: 'tag-area-ec',        key: 'area_ec',         label: getBuiltinTagLabel('area_ec'),        row: 'bottom', pre_sec: 6,  post_sec: 4,  order: 9  },
        { id: 'tag-contragolpe-ec', key: 'contragolpe_ec',  label: getBuiltinTagLabel('contragolpe_ec'), row: 'bottom', pre_sec: 5,  post_sec: 7,  order: 10 },
        { id: 'tag-cc-def',         key: 'cc_def',          label: getBuiltinTagLabel('cc_def'),         row: 'bottom', pre_sec: 3,  post_sec: 8,  order: 11 },
        { id: 'tag-gol-ec',         key: 'gol_ec',          label: getBuiltinTagLabel('gol_ec'),         row: 'bottom', pre_sec: 10, post_sec: 3,  order: 12 },
    ];
}

const BUILTIN_DEFAULT = {
    id: 'builtin-default',
    name: 'Hockey (Default)',
    isSystem: true,
    order: 0,
    get buttons() { return _resolvedBuiltinButtons(); },
};

export const ButtonboardTemplates = (() => {

    // Deep clone a buttons array to ensure no reference sharing
    function cloneButtons(buttons) {
        return (buttons || []).map(b => ({ ...b }));
    }

    // ── System templates (global Firestore collection, read-only for users) ──
    async function getSystemTemplates() {
        try {
            const q = query(collection(db, 'buttonboard_templates'), orderBy('order', 'asc'));
            const snap = await getDocs(q);
            const results = snap.docs.map(d => ({ id: d.id, ...d.data(), isSystem: true }));
            // Always ensure at least the built-in default is present
            if (results.length === 0) return [BUILTIN_DEFAULT];
            return results;
        } catch (e) {
            console.warn('Could not load system templates from Firebase, using built-in default:', e);
            return [BUILTIN_DEFAULT];
        }
    }

    // ── User templates (per-user subcollection) ──
    async function getUserTemplates(uid) {
        if (!uid) return [];
        try {
            const q = query(
                collection(db, 'users', uid, 'buttonboard_templates'),
                orderBy('createdAt', 'desc')
            );
            const snap = await getDocs(q);
            return snap.docs.map(d => ({ id: d.id, ...d.data(), isSystem: false }));
        } catch (e) {
            console.warn('Could not load user templates:', e);
            return [];
        }
    }

    // Save a user template (create or update)
    // data: { id?, name, buttons[] }
    // Returns the new/existing document ID
    async function saveUserTemplate(uid, data) {
        if (!uid) throw new Error('No authenticated user');
        const payload = {
            name: data.name || t('js.noName'),
            buttons: cloneButtons(data.buttons),
            updatedAt: serverTimestamp(),
        };
        try {
            if (data.id) {
                await setDoc(doc(db, 'users', uid, 'buttonboard_templates', data.id), payload, { merge: true });
                return data.id;
            } else {
                payload.createdAt = serverTimestamp();
                const ref = await addDoc(collection(db, 'users', uid, 'buttonboard_templates'), payload);
                return ref.id;
            }
        } catch (e) {
            // Expose the real Firebase error (code + message) for easier debugging
            console.error('[ButtonboardTemplates] saveUserTemplate failed:', e.code, e.message, e);
            const detail = e.code ? `(${e.code})` : '';
            throw new Error(`No se pudo guardar el template ${detail}: ${e.message}`);
        }
    }

    async function deleteUserTemplate(uid, id) {
        if (!uid || !id) return;
        await deleteDoc(doc(db, 'users', uid, 'buttonboard_templates', id));
    }

    async function duplicateTemplate(uid, template) {
        if (!uid) return;
        return saveUserTemplate(uid, {
            name: (template.name || 'Template') + ' ' + t('js.templateCopy'),
            buttons: cloneButtons(template.buttons),
        });
    }

    // Create a project-local copy of a template (no live link)
    function cloneTemplateForProject(template) {
        return {
            id: 'bb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
            name: template.name || t('js.codeWindowDefault'),
            buttons: cloneButtons(template.buttons),
        };
    }

    return {
        getSystemTemplates,
        getUserTemplates,
        saveUserTemplate,
        deleteUserTemplate,
        duplicateTemplate,
        cloneTemplateForProject,
        cloneButtons,
        BUILTIN_DEFAULT,
    };
})();
