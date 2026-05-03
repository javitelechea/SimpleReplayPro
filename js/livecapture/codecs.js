/**
 * Lista codecs MIME soportados por MediaRecorder en este navegador.
 */
export function detectSupportedMimeTypes() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm;codecs=h264',
    'video/webm',
    'video/mp4;codecs=avc1',
  ];
  return candidates.filter((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
}
