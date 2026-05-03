/**
 * Une segmentos WebM en un único Blob (misma lógica validada en el spike).
 */

/**
 * @param {(Blob|File)[]} parts
 * @param {string} [mimeTypeHint]
 * @returns {Blob}
 */
export function concatenateSegments(parts, mimeTypeHint = 'video/webm') {
  if (!parts.length) {
    return new Blob([], { type: mimeTypeHint });
  }
  const mt =
    parts[0]?.type ||
    (parts[0] instanceof File && parts[0].type) ||
    mimeTypeHint;
  return new Blob(parts, { type: mt });
}
