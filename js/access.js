export function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  return null;
}

export function isEffectivePro(userDoc, nowMs = Date.now()) {
  if (!userDoc) return false;

  const accessType = String(userDoc.accessType || '').trim().toLowerCase();
  const plan = String(userDoc.plan || '').trim().toLowerCase();

  // Legacy/compat values used before current access model.
  if (['paid', 'pro', 'premium', 'lifetime'].includes(accessType)) return true;

  if (accessType === 'granted') {
    const expMs = toMillis(userDoc.grantExpiresAt);
    // Backward compatibility: old docs may have granted access without expiry.
    if (!expMs) return true;
    return expMs > nowMs;
  }

  return ['pro', 'premium', 'paid'].includes(plan);
}
