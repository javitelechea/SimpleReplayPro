import { isEffectivePro } from './access.js';

export const FEATURES = {
    CLOUD_PROJECTS: 'cloudProjects',
    LOCAL_VIDEO: 'localVideo',
    SHARE: 'share',
    IMPORT_DATA: 'importData',
    EXPORT_DATA: 'exportData',
    COMMENTS: 'comments',
    BUTTONBOARD_TEMPLATES: 'buttonboardTemplates', // Ventanas de código — panel de templates (PRO)
    // MULTIPLE_BUTTONBOARDS: 'multipleButtonboards', // Reservado: múltiples ventanas de código activas
};

const PLAN_FEATURES = {
    free: [FEATURES.CLOUD_PROJECTS, FEATURES.COMMENTS],
    pro: Object.values(FEATURES),
};

export function resolveEffectivePlan(userDoc) {
    if (!userDoc) return 'free';
    if (isEffectivePro(userDoc)) return 'pro';
    return userDoc.plan === 'pro' ? 'pro' : 'free';
}

export function resolveFeaturesForUser(userDoc) {
    const plan = resolveEffectivePlan(userDoc);
    const allowed = PLAN_FEATURES[plan] || PLAN_FEATURES.free;
    const flags = {};
    for (const f of Object.values(FEATURES)) {
        flags[f] = allowed.includes(f);
    }
    return flags;
}
