/**
 * Utilidades para reflejar dibujos de la app principal en el player externo.
 * Coordenadas normalizadas (0–1) respecto al canvas de origen.
 */

export function normalizePoint(x, y, w, h) {
    const width = Math.max(1, Number(w) || 1);
    const height = Math.max(1, Number(h) || 1);
    return { nx: x / width, ny: y / height };
}

export function denormalizePoint(pt, w, h) {
    const width = Math.max(1, Number(w) || 1);
    const height = Math.max(1, Number(h) || 1);
    if (pt && typeof pt.nx === 'number' && typeof pt.ny === 'number') {
        return { x: pt.nx * width, y: pt.ny * height };
    }
    return { x: Number(pt?.x) || 0, y: Number(pt?.y) || 0 };
}

export function normalizeStroke(stroke, w, h) {
    if (!stroke) return null;
    return {
        color: stroke.color,
        width: stroke.width,
        eraser: !!stroke.eraser,
        arrow: !!stroke.arrow,
        points: (stroke.points || []).map((p) => normalizePoint(p.x, p.y, w, h)),
    };
}

export function normalizeStrokeList(strokes, w, h) {
    return (strokes || []).map((s) => normalizeStroke(s, w, h));
}

export function denormalizeStroke(stroke, w, h) {
    if (!stroke) return null;
    return {
        color: stroke.color,
        width: stroke.width,
        eraser: !!stroke.eraser,
        arrow: !!stroke.arrow,
        points: (stroke.points || []).map((p) => denormalizePoint(p, w, h)),
    };
}

export function denormalizeStrokeList(strokes, w, h) {
    return (strokes || []).map((s) => denormalizeStroke(s, w, h));
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

export function paintStrokeList(ctx, strokes, w, h, normalized = true) {
    if (!ctx) return;
    const list = normalized ? denormalizeStrokeList(strokes, w, h) : (strokes || []);
    list.forEach((stroke) => paintStroke(ctx, stroke));
    ctx.globalCompositeOperation = 'source-over';
}

export function paintLinePreview(ctx, preview, w, h) {
    if (!ctx || !preview?.lineStart || !preview.point) return;
    const from = denormalizePoint(preview.lineStart, w, h);
    const to = denormalizePoint(preview.point, w, h);
    const color = preview.color || '#ff3b3b';
    const lineWidth = preview.width || 4;
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

export function paintPenPreview(ctx, previewStroke, w, h) {
    if (!ctx || !previewStroke) return;
    const stroke = denormalizeStroke(previewStroke, w, h);
    if (!stroke || stroke.points.length < 2) return;
    paintStroke(ctx, stroke);
}
