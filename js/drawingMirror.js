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

export function normalizeStrokeInFrame(stroke, frame) {
    if (!stroke) return null;
    return {
        color: stroke.color,
        width: stroke.width,
        eraser: !!stroke.eraser,
        arrow: !!stroke.arrow,
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
    const list = denormalizeStrokeListInFrame(strokes, frame, sourceFrame);
    list.forEach((stroke) => paintStroke(ctx, stroke));
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
