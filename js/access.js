export function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  return null;
}

export function isEffectivePro(userDoc, nowMs = Date.now()) {
  if (!userDoc) return false;

  if (userDoc.accessType === 'paid') return true;

  if (userDoc.accessType === 'granted') {
    const expMs = toMillis(userDoc.grantExpiresAt);
    return !!expMs && expMs > nowMs;
  }

  return userDoc.plan === 'pro';
}
