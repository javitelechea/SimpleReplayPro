/**
 * Espejo de dibujos entre ventana principal y player externo.
 * Coordenadas normalizadas al rectángulo visible del video (sin bandas negras).
 */

const DEFAULT_ASPECT = 16 / 9;

/** @typedef {{ containerW: number, containerH: number, left: number, top: number, width: number, height: number, aspect: number }} VideoFrameMetrics */

export function computeVideoFrameRect(containerW, containerH, videoAspect = DEFAULT_ASPECT) {
    const cw = Math.max(1, containerW || 1);
    const ch = Math.max(1, containerH || 1);
    const ar = videoAspect > 0 ? videoAspect : DEFAULT_ASPECT;
    const ca = cw / ch;
    let fw;
    let fh;
    let left;
    let top;
    if (ca > ar) {
        fh = ch;
        fw = ch * ar;
        left = (cw - fw) / 2;
        top = 0;
    } else {
        fw = cw;
        fh = cw / ar;
        left = 0;
        top = (ch - fh) / 2;
    }
    return {
        containerW: cw,
        containerH: ch,
        left,
        top,
        width: fw,
        height: fh,
        aspect: ar,
    };
}

/**
 * Rectángulo del video renderizado dentro de un contenedor (object-fit / iframe).
 * @param {HTMLElement} container — p. ej. #player-container o #popout-player
 * @returns {VideoFrameMetrics}
 */
export function getVideoFrameMetricsFromElement(container) {
    if (!container) {
        return computeVideoFrameRect(1, 1, DEFAULT_ASPECT);
    }
    const cr = container.getBoundingClientRect();
    const cw = cr.width || container.clientWidth || 1;
    const ch = cr.height || container.clientHeight || 1;

    const video = container.querySelector(
        'video:not(#live-preview-video):not(#live-replay-video)'
    );
    if (video) {
        const vr = video.getBoundingClientRect();
        const w = Math.max(1, vr.width);
        const h = Math.max(1, vr.height);
        return {
            containerW: cw,
            containerH: ch,
            left: vr.left - cr.left,
            top: vr.top - cr.top,
            width: w,
            height: h,
            aspect: w / h,
        };
    }

    const iframe = container.querySelector('iframe');
    if (iframe) {
        const ir = iframe.getBoundingClientRect();
        const iw = Math.max(1, ir.width);
        const ih = Math.max(1, ir.height);
        const inner = computeVideoFrameRect(iw, ih, DEFAULT_ASPECT);
        return {
            containerW: cw,
            containerH: ch,
            left: ir.left - cr.left + inner.left,
            top: ir.top - cr.top + inner.top,
            width: inner.width,
            height: inner.height,
            aspect: inner.aspect,
        };
    }

    return computeVideoFrameRect(cw, ch, DEFAULT_ASPECT);
}

export function normalizePointInFrame(x, y, frame) {
    const w = Math.max(1, frame?.width || 1);
    const h = Math.max(1, frame?.height || 1);
    return {
        nx: (x - (frame?.left || 0)) / w,
        ny: (y - (frame?.top || 0)) / h,
    };
}

export function denormalizePointInFrame(pt, frame) {
    const w = Math.max(1, frame?.width || 1);
    const h = Math.max(1, frame?.height || 1);
    if (pt && typeof pt.nx === 'number' && typeof pt.ny === 'number') {
        return {
            x: (frame?.left || 0) + pt.nx * w,
            y: (frame?.top || 0) + pt.ny * h,
        };
    }
    return { x: Number(pt?.x) || 0, y: Number(pt?.y) || 0 };
}

export const CIRCLE_FILL_OPACITY = 0.5;
/** Tamaño de la “base” de jugador (cámara táctica) a ~1920px de ancho de video. */
export const PLAYER_BASE_REF_WIDTH = 1920;
export const PLAYER_BASE_RX = 30;
export const PLAYER_BASE_RY = 11;

export function colorWithAlpha(hex, alpha) {
    const h = String(hex || '#ff3b3b').replace('#', '');
    if (h.length !== 6) return `rgba(255, 59, 59, ${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function frameScaleFromWidth(frameWidth, sourceWidth = PLAYER_BASE_REF_WIDTH) {
    const w = frameWidth > 0 ? frameWidth : PLAYER_BASE_REF_WIDTH;
    const ref = sourceWidth > 0 ? sourceWidth : PLAYER_BASE_REF_WIDTH;
    return Math.max(0.55, Math.min(1.45, w / ref));
}

/**
 * Clic corto: p0 = centro del óvalo.
 * Arrastrar: p0 y p1 = esquinas opuestas de la caja.
 */
export function ovalMetricsFromPoints(p0, p1, frameScale = 1, stamp = false) {
    const s = frameScale > 0 ? frameScale : 1;
    const minAspect = PLAYER_BASE_RX / PLAYER_BASE_RY;
    const anchor = p0 || { x: 0, y: 0 };

    if (stamp || !p1) {
        const rx = PLAYER_BASE_RX * s;
        const ry = PLAYER_BASE_RY * s;
        return {
            cx: anchor.x,
            cy: anchor.y,
            rx,
            ry,
            bbox: { left: anchor.x - rx, top: anchor.y - ry, width: rx * 2, height: ry * 2 },
        };
    }

    const opposite = p1;
    const left = Math.min(anchor.x, opposite.x);
    const right = Math.max(anchor.x, opposite.x);
    const top = Math.min(anchor.y, opposite.y);
    const bottom = Math.max(anchor.y, opposite.y);

    let rx = Math.max(PLAYER_BASE_RY * s, (right - left) / 2);
    let ry = Math.max(4, (bottom - top) / 2);
    if (rx / ry < minAspect) rx = ry * minAspect;

    return {
        cx: (left + right) / 2,
        cy: (top + bottom) / 2,
        rx,
        ry,
        bbox: { left, top, width: right - left, height: bottom - top },
    };
}

export function paintOvalBBoxPreview(ctx, p0, p1, color, fillOpacity = CIRCLE_FILL_OPACITY, frameScale = 1, stamp = false) {
    const m = ovalMetricsFromPoints(p0, p1, frameScale, stamp);
    if (!ctx || !m.bbox) return;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colorWithAlpha(color, 0.45);
    ctx.lineWidth = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeRect(m.bbox.left, m.bbox.top, m.bbox.width, m.bbox.height);
    ctx.restore();
    paintOval(ctx, m.cx, m.cy, m.rx, m.ry, color, fillOpacity);
}

/** @deprecated círculos viejos guardados */
export function circleMetricsFromPoints(p0, p1) {
    const cx = p0?.x ?? 0;
    const cy = p0?.y ?? 0;
    const r = Math.max(2, Math.hypot((p1?.x ?? cx) - cx, (p1?.y ?? cy) - cy));
    return { cx, cy, r };
}

export function paintOval(ctx, cx, cy, rx, ry, color, fillOpacity = CIRCLE_FILL_OPACITY) {
    if (!ctx || rx < 1 || ry < 1) return;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = colorWithAlpha(color, fillOpacity);
    ctx.fill();
}

export function paintOvalFromPoints(ctx, p0, p1, color, fillOpacity = CIRCLE_FILL_OPACITY, frameScale = 1, stamp = false) {
    const { cx, cy, rx, ry } = ovalMetricsFromPoints(p0, p1, frameScale, stamp);
    paintOval(ctx, cx, cy, rx, ry, color, fillOpacity);
}

export function paintCircle(ctx, cx, cy, r, color, fillOpacity = CIRCLE_FILL_OPACITY) {
    paintOval(ctx, cx, cy, r, r, color, fillOpacity);
}

export function paintCircleFromPoints(ctx, p0, p1, color, fillOpacity = CIRCLE_FILL_OPACITY) {
    const { cx, cy, r } = circleMetricsFromPoints(p0, p1);
    paintCircle(ctx, cx, cy, r, color, fillOpacity);
}

export function normalizeStrokeInFrame(stroke, frame) {
    if (!stroke) return null;
    return {
        color: stroke.color,
        width: stroke.width,
        eraser: !!stroke.eraser,
        arrow: !!stroke.arrow,
        circle: !!(stroke.oval || stroke.circle),
        oval: !!(stroke.oval || stroke.circle),
        stamp: !!stroke.stamp,
        fillOpacity: (stroke.oval || stroke.circle) ? (stroke.fillOpacity ?? CIRCLE_FILL_OPACITY) : undefined,
        points: (stroke.points || []).map((p) => normalizePointInFrame(p.x, p.y, frame)),
    };
}

export function normalizeStrokeListInFrame(strokes, frame) {
    return (strokes || []).map((s) => normalizeStrokeInFrame(s, frame));
}

export function denormalizeStrokeInFrame(stroke, frame, sourceFrame = null) {
    if (!stroke) return null;
    const scale = sourceFrame && sourceFrame.width > 0
        ? frame.width / sourceFrame.width
        : 1;
    return {
        color: stroke.color,
        width: Math.max(0.5, (stroke.width || 4) * scale),
        eraser: !!stroke.eraser,
        arrow: !!stroke.arrow,
        circle: !!(stroke.oval || stroke.circle),
        oval: !!(stroke.oval || stroke.circle),
        stamp: !!stroke.stamp,
        fillOpacity: (stroke.oval || stroke.circle) ? (stroke.fillOpacity ?? CIRCLE_FILL_OPACITY) : undefined,
        points: (stroke.points || []).map((p) => denormalizePointInFrame(p, frame)),
    };
}

export function denormalizeStrokeListInFrame(strokes, frame, sourceFrame = null) {
    return (strokes || []).map((s) => denormalizeStrokeInFrame(s, frame, sourceFrame));
}

function drawArrowhead(ctx, from, to, color, width) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = Math.max(12, width * 4);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.globalCompositeOperation = 'source-over';
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(
        to.x - size * Math.cos(angle - Math.PI / 6),
        to.y - size * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        to.x - size * Math.cos(angle + Math.PI / 6),
        to.y - size * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
}

export function paintStroke(ctx, stroke) {
    if (!ctx || !stroke || !stroke.points?.length) return;

    if ((stroke.oval || stroke.circle) && stroke.points.length >= 1) {
        const p0 = stroke.points[0];
        const p1 = stroke.points.length >= 2 ? stroke.points[stroke.points.length - 1] : null;
        const scale = stroke._frameScale ?? 1;
        paintOvalFromPoints(
            ctx,
            p0,
            p1,
            stroke.color,
            stroke.fillOpacity ?? CIRCLE_FILL_OPACITY,
            scale,
            !!stroke.stamp || stroke.points.length < 2
        );
        return;
    }

    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';

    if (stroke.arrow && stroke.points.length >= 2) {
        const from = stroke.points[0];
        const to = stroke.points[stroke.points.length - 1];
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const size = Math.max(12, stroke.width * 4);
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x - size * Math.cos(angle), to.y - size * Math.sin(angle));
        ctx.stroke();
        drawArrowhead(ctx, from, to, stroke.color, stroke.width);
    } else {
        stroke.points.forEach((pt, i) => {
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
    }
}

/**
 * Pinta trazos normalizados al frame de video del canvas.
 */
export function paintStrokeListInFrame(ctx, strokes, frame, sourceFrame = null) {
    if (!ctx || !frame) return;
    const scale = frameScaleFromWidth(frame.width, sourceFrame?.width);
    const list = denormalizeStrokeListInFrame(strokes, frame, sourceFrame);
    list.forEach((stroke) => {
        if (stroke.oval || stroke.circle) stroke._frameScale = scale;
        paintStroke(ctx, stroke);
    });
    ctx.globalCompositeOperation = 'source-over';
}

export function paintLinePreviewInFrame(ctx, preview, frame, sourceFrame = null) {
    if (!ctx || !preview?.lineStart || !preview.point || !frame) return;
    const scale = sourceFrame?.width > 0 ? frame.width / sourceFrame.width : 1;
    const from = denormalizePointInFrame(preview.lineStart, frame);
    const to = denormalizePointInFrame(preview.point, frame);
    const color = preview.color || '#ff3b3b';
    const lineWidth = Math.max(0.5, (preview.width || 4) * scale);
    const isArrow = preview.tool === 'arrow';

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';

    if (isArrow) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const size = Math.max(12, lineWidth * 4);
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x - size * Math.cos(angle), to.y - size * Math.sin(angle));
        ctx.stroke();
        drawArrowhead(ctx, from, to, color, lineWidth);
    } else {
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
    }
}

export function paintPenPreviewInFrame(ctx, previewStroke, frame, sourceFrame = null) {
    if (!ctx || !previewStroke) return;
    const stroke = denormalizeStrokeInFrame(previewStroke, frame, sourceFrame);
    if (!stroke || stroke.points.length < 2) return;
    paintStroke(ctx, stroke);
}

export function paintCirclePreviewInFrame(ctx, preview, frame, sourceFrame = null) {
    if (!ctx || !preview?.lineStart || !frame) return;
    const scale = frameScaleFromWidth(frame.width, sourceFrame?.width);
    const from = denormalizePointInFrame(preview.lineStart, frame);
    const color = preview.color || '#ff3b3b';
    const opacity = preview.fillOpacity ?? CIRCLE_FILL_OPACITY;
    if (preview.stamp || !preview.point) {
        paintOvalFromPoints(ctx, from, null, color, opacity, scale, true);
        return;
    }
    const to = denormalizePointInFrame(preview.point, frame);
    paintOvalBBoxPreview(ctx, from, to, color, opacity, scale, false);
}

/** Compatibilidad con payloads viejos (normalización al canvas completo). */
export function normalizeStrokeList(strokes, w, h) {
    const frame = computeVideoFrameRect(w, h, w / h);
    frame.left = 0;
    frame.top = 0;
    return normalizeStrokeListInFrame(strokes, frame);
}

export function normalizeStroke(stroke, w, h) {
    const frame = computeVideoFrameRect(w, h, w / h);
    frame.left = 0;
    frame.top = 0;
    return normalizeStrokeInFrame(stroke, frame);
}
