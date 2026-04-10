/* ═══════════════════════════════════════════
   SimpleReplay — Drawing Annotation Tool
   Canvas overlay on video for freehand drawing
   ═══════════════════════════════════════════ */

import { AppState } from './state.js';
import { YTPlayer } from './youtubePlayer.js';

export const DrawingTool = (() => {
    'use strict';

    let _canvas = null;
    let _ctx = null;
    let _toolbar = null;
    let _active = false;
    let _drawing = false;
    let _playlistId = null;
    let _clipId = null;
    let _videoTimestamp = 0; // exact second in the video when drawing was started

    // Drawing state
    let _color = '#ff3b3b';
    let _lineWidth = 4;
    let _tool = 'pen'; // 'pen' | 'eraser'
    let _strokes = []; // array of stroke objects for undo
    let _currentStroke = null;

    // Straight-line mode (Shift+drag)
    let _lineMode = false;
    let _lineStart = null; // { x, y } of mousedown when Shift is held

    // Playback watch (auto-show drawings at their timestamp)
    let _watchTimer = null;
    let _watchPlaylistId = null;
    let _watchClipId = null;
    let _watchShownIds = new Set(); // drawing comment IDs already shown this session

    // ── Init (called once on app load) ──
    function init() {
        _canvas = document.getElementById('drawing-canvas');
        _toolbar = document.getElementById('drawing-toolbar');
        if (!_canvas || !_toolbar) return;
        _ctx = _canvas.getContext('2d');

        // Mouse events
        _canvas.addEventListener('mousedown', _onPointerDown);
        _canvas.addEventListener('mousemove', _onPointerMove);
        _canvas.addEventListener('mouseup', _onPointerUp);
        _canvas.addEventListener('mouseleave', _onPointerUp);

        // Touch events
        _canvas.addEventListener('touchstart', _onTouchStart, { passive: false });
        _canvas.addEventListener('touchmove', _onTouchMove, { passive: false });
        _canvas.addEventListener('touchend', _onTouchEnd);
        _canvas.addEventListener('touchcancel', _onTouchEnd);

        // Toolbar buttons
        _toolbar.querySelector('[data-action="draw-save"]').addEventListener('click', save);
        _toolbar.querySelector('[data-action="draw-cancel"]').addEventListener('click', close);
        _toolbar.querySelector('[data-action="draw-clear"]').addEventListener('click', clearCanvas);
        _toolbar.querySelector('[data-action="draw-undo"]').addEventListener('click', undo);

        // Color swatches
        _toolbar.querySelectorAll('.draw-color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                _color = swatch.dataset.color;
                // Only switch to pen if coming from eraser; keep line/arrow as-is
                if (_tool === 'eraser') _tool = 'pen';
                _updateToolbar();
            });
        });

        // Eraser
        _toolbar.querySelector('[data-action="draw-eraser"]').addEventListener('click', () => {
            _tool = _tool === 'eraser' ? 'pen' : 'eraser';
            _updateToolbar();
        });

        // Line
        _toolbar.querySelector('[data-action="draw-line"]').addEventListener('click', () => {
            _tool = _tool === 'line' ? 'pen' : 'line';
            _updateToolbar();
        });

        // Arrow
        _toolbar.querySelector('[data-action="draw-arrow"]').addEventListener('click', () => {
            _tool = _tool === 'arrow' ? 'pen' : 'arrow';
            _updateToolbar();
        });

        // Brush size
        const sizeSlider = _toolbar.querySelector('#draw-size');
        if (sizeSlider) {
            sizeSlider.addEventListener('input', () => {
                _lineWidth = parseInt(sizeSlider.value, 10);
            });
        }
    }

    // ── Open drawing mode ──
    function open(playlistId, clipId) {
        if (_active) return;
        _playlistId = playlistId;
        _clipId = clipId;
        _active = true;
        _strokes = [];
        _currentStroke = null;
        _tool = 'pen';
        _color = '#ff3b3b';
        _lineWidth = 4;

        // Capture exact video timestamp
        _videoTimestamp = YTPlayer.getCurrentTime();

        // Pause the video
        YTPlayer.pause();

        // Resize canvas to match player container
        _resizeCanvas();

        // Show canvas & toolbar
        _canvas.classList.add('active');
        _toolbar.classList.add('active');

        // Clear
        _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        _updateToolbar();

        // Disable save button if no playlist (can draw but not save)
        const saveBtn = _toolbar.querySelector('[data-action="draw-save"]');
        if (saveBtn) {
            if (_playlistId) {
                saveBtn.disabled = false;
                saveBtn.style.opacity = '1';
                saveBtn.style.cursor = 'pointer';
                saveBtn.title = 'Guardar dibujo';
            } else {
                saveBtn.disabled = true;
                saveBtn.style.opacity = '0.35';
                saveBtn.style.cursor = 'not-allowed';
                saveBtn.title = 'Agregá el clip a una playlist para poder guardar';
            }
        }

        // Listen for window resize
        window.addEventListener('resize', _resizeCanvas);
    }

    // ── Close drawing mode (no save) ──
    function close() {
        if (!_active) return;
        _active = false;
        _canvas.classList.remove('active');
        _toolbar.classList.remove('active');
        window.removeEventListener('resize', _resizeCanvas);
        _strokes = [];
        _currentStroke = null;
        // Clear description field
        const descInput = _toolbar && _toolbar.querySelector('#draw-description');
        if (descInput) descInput.value = '';
    }

    // ── Save drawing as comment ──
    function save() {
        if (!_active) return;
        if (!_playlistId) {
            UI.toast('Agregá el clip a una playlist para poder guardar el dibujo', 'warning');
            return;
        }
        if (_strokes.length === 0) {
            UI.toast('Dibujá algo antes de guardar', 'error');
            return;
        }

        const dataUrl = _canvas.toDataURL('image/png');
        const savedName = localStorage.getItem('sr_chat_name') || 'Anónimo';

        // Read description from toolbar input
        const descInput = _toolbar && _toolbar.querySelector('#draw-description');
        const description = descInput && descInput.value.trim() ? descInput.value.trim() : '🎨 Dibujo';

        AppState.addComment(_playlistId, _clipId, savedName, description, dataUrl, _videoTimestamp);

        UI.toast('Dibujo guardado 🎨', 'success');
        close();
    }

    // ── Clear canvas ──
    function clearCanvas() {
        _strokes = [];
        _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    }

    // ── Undo last stroke ──
    function undo() {
        if (_strokes.length === 0) return;
        _strokes.pop();
        _redraw();
    }

    // ── Arrowhead helper ──
    function _drawArrowhead(ctx, from, to, color, width) {
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

    // ── Redraw all strokes ──
    function _redraw() {
        _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        _strokes.forEach(stroke => {
            _ctx.beginPath();
            _ctx.strokeStyle = stroke.color;
            _ctx.lineWidth = stroke.width;
            _ctx.lineCap = 'round';
            _ctx.lineJoin = 'round';
            _ctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';

            if (stroke.arrow && stroke.points.length >= 2) {
                // Shorten line so it ends at the arrowhead base, not the tip
                const from = stroke.points[0];
                const to = stroke.points[stroke.points.length - 1];
                const angle = Math.atan2(to.y - from.y, to.x - from.x);
                const size = Math.max(12, stroke.width * 4);
                _ctx.moveTo(from.x, from.y);
                _ctx.lineTo(to.x - size * Math.cos(angle), to.y - size * Math.sin(angle));
                _ctx.stroke();
                _drawArrowhead(_ctx, from, to, stroke.color, stroke.width);
            } else {
                stroke.points.forEach((pt, i) => {
                    if (i === 0) _ctx.moveTo(pt.x, pt.y);
                    else _ctx.lineTo(pt.x, pt.y);
                });
                _ctx.stroke();
            }
        });
        _ctx.globalCompositeOperation = 'source-over';
    }

    // ── Pointer events ──
    function _onPointerDown(e) {
        if (!_active) return;
        _drawing = true;
        const rect = _canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if ((e.shiftKey || _tool === 'line' || _tool === 'arrow') && _tool !== 'eraser') {
            // Straight-line / arrow mode: record start and wait for mouseup
            _lineMode = true;
            _lineStart = { x, y };
            return;
        }

        _lineMode = false;
        _currentStroke = {
            color: _tool === 'eraser' ? '#000' : _color,
            width: _tool === 'eraser' ? _lineWidth * 3 : _lineWidth,
            eraser: _tool === 'eraser',
            points: [{ x, y }]
        };
        _ctx.beginPath();
        _ctx.strokeStyle = _currentStroke.color;
        _ctx.lineWidth = _currentStroke.width;
        _ctx.lineCap = 'round';
        _ctx.lineJoin = 'round';
        _ctx.globalCompositeOperation = _currentStroke.eraser ? 'destination-out' : 'source-over';
        _ctx.moveTo(x, y);
    }

    function _onPointerMove(e) {
        if (!_drawing) return;
        const rect = _canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (_lineMode && _lineStart) {
            // Rubber-band preview: redraw saved strokes + temporary line/arrow
            _redraw();
            _ctx.beginPath();
            _ctx.strokeStyle = _color;
            _ctx.lineWidth = _lineWidth;
            _ctx.lineCap = 'round';
            _ctx.lineJoin = 'round';
            _ctx.globalCompositeOperation = 'source-over';
            if (_tool === 'arrow') {
                // Shorten preview line to stop at arrowhead base
                const angle = Math.atan2(y - _lineStart.y, x - _lineStart.x);
                const size = Math.max(12, _lineWidth * 4);
                _ctx.moveTo(_lineStart.x, _lineStart.y);
                _ctx.lineTo(x - size * Math.cos(angle), y - size * Math.sin(angle));
                _ctx.stroke();
                _drawArrowhead(_ctx, _lineStart, { x, y }, _color, _lineWidth);
            } else {
                _ctx.moveTo(_lineStart.x, _lineStart.y);
                _ctx.lineTo(x, y);
                _ctx.stroke();
            }
            return;
        }

        if (!_currentStroke) return;
        _currentStroke.points.push({ x, y });
        _ctx.lineTo(x, y);
        _ctx.stroke();
        _ctx.beginPath();
        _ctx.moveTo(x, y);
    }

    function _onPointerUp(e) {
        if (!_drawing) return;
        _drawing = false;
        _ctx.globalCompositeOperation = 'source-over';

        if (_lineMode && _lineStart && e) {
            const rect = _canvas.getBoundingClientRect();
            const x = (e.clientX ?? _lineStart.x) - rect.left;
            const y = (e.clientY ?? _lineStart.y) - rect.top;
            const lineStroke = {
                color: _color,
                width: _lineWidth,
                eraser: false,
                arrow: _tool === 'arrow',
                points: [_lineStart, { x, y }]
            };
            _strokes.push(lineStroke);
            _redraw();
            _lineMode = false;
            _lineStart = null;
            return;
        }

        if (_currentStroke && _currentStroke.points.length > 1) {
            _strokes.push(_currentStroke);
        }
        _currentStroke = null;
        _lineMode = false;
        _lineStart = null;
    }

    // ── Touch events (mobile/tablet) ──
    function _onTouchStart(e) {
        e.preventDefault();
        const touch = e.touches[0];
        _onPointerDown({ clientX: touch.clientX, clientY: touch.clientY, shiftKey: false });
    }

    function _onTouchMove(e) {
        e.preventDefault();
        const touch = e.touches[0];
        _onPointerMove({ clientX: touch.clientX, clientY: touch.clientY });
    }

    function _onTouchEnd(e) {
        const touch = e.changedTouches && e.changedTouches[0];
        _onPointerUp(touch ? { clientX: touch.clientX, clientY: touch.clientY } : null);
    }

    // ── Resize canvas to fill player container ──
    function _resizeCanvas() {
        const container = document.getElementById('player-container');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        _canvas.width = rect.width;
        _canvas.height = rect.height;
        // Redraw after resize
        _redraw();
    }

    // ── Update toolbar active states ──
    function _updateToolbar() {
        _toolbar.querySelectorAll('.draw-color-swatch').forEach(swatch => {
            swatch.classList.toggle('active', swatch.dataset.color === _color && _tool === 'pen');
        });
        const eraserBtn = _toolbar.querySelector('[data-action="draw-eraser"]');
        if (eraserBtn) eraserBtn.classList.toggle('active', _tool === 'eraser');
        const lineBtn = _toolbar.querySelector('[data-action="draw-line"]');
        if (lineBtn) lineBtn.classList.toggle('active', _tool === 'line');
        const arrowBtn = _toolbar.querySelector('[data-action="draw-arrow"]');
        if (arrowBtn) arrowBtn.classList.toggle('active', _tool === 'arrow');

        const sizeSlider = _toolbar.querySelector('#draw-size');
        if (sizeSlider) sizeSlider.value = _lineWidth;
    }

    // ── Show a saved drawing overlay on the video ──
    function showDrawingOverlay(dataUrl, videoTimeSec) {
        // Seek to the exact moment the drawing was made
        if (videoTimeSec !== undefined && videoTimeSec !== null) {
            YTPlayer.seekTo(videoTimeSec);
            YTPlayer.pause();
        }

        // Create or reuse overlay
        let overlay = document.getElementById('drawing-preview-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'drawing-preview-overlay';
            overlay.className = 'drawing-preview-overlay';
            document.getElementById('player-container').appendChild(overlay);
        }

        overlay.innerHTML = `<img src="${dataUrl}" alt="Dibujo" /><button class="drawing-preview-close" title="Cerrar">✕</button>`;
        overlay.classList.add('active');

        overlay.querySelector('.drawing-preview-close').addEventListener('click', () => {
            overlay.classList.remove('active');
        });

        // Click outside drawing to close
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    }

    function isActive() { return _active; }

    // ── Playback Watch ──
    // Monitors video time and auto-shows drawings when their timestamp is reached.

    function startPlaybackWatch(playlistId, clipId) {
        stopPlaybackWatch();
        dismissPlaybackOverlays(); // clear any overlay from a previous clip
        if (!playlistId || !clipId) return;
        _watchPlaylistId = playlistId;
        _watchClipId = clipId;
        _watchShownIds = new Set();

        _watchTimer = setInterval(() => {
            if (_active) return; // Don’t trigger while user is drawing

            const drawings = _getDrawingComments(playlistId, clipId);
            if (!drawings.length) return;

            const t = YTPlayer.getCurrentTime();
            drawings.forEach(d => {
                if (_watchShownIds.has(d.id)) return;
                if (d.videoTimeSec === undefined || d.videoTimeSec === null) return;
                if (t >= d.videoTimeSec) {
                    _watchShownIds.add(d.id);
                    // Seek back slightly before pausing to prevent YouTube showing
                    // its "more videos" overlay (which it triggers at natural pause points)
                    YTPlayer.seekTo(Math.max(0, d.videoTimeSec - 1));
                    YTPlayer.pause();
                    _showAutoOverlay(d);
                }
            });
        }, 200);
    }

    function stopPlaybackWatch() {
        if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
        _watchPlaylistId = null;
        _watchClipId = null;
        _watchShownIds = new Set();
    }

    function hasPlaybackOverlays() {
        return document.querySelectorAll('.drawing-auto-overlay').length > 0;
    }

    function dismissPlaybackOverlays() {
        document.querySelectorAll('.drawing-auto-overlay').forEach(el => el.remove());
    }

    function _getDrawingComments(playlistId, clipId) {
        const comments = AppState.getComments(playlistId, clipId);
        return comments
            .filter(c => c.drawing && c.videoTimeSec !== undefined && c.videoTimeSec !== null)
            .sort((a, b) => a.videoTimeSec - b.videoTimeSec);
    }

    function _showAutoOverlay(comment) {
        const container = document.getElementById('player-container');
        if (!container) return;

        const overlay = document.createElement('div');
        overlay.className = 'drawing-auto-overlay';

        const descText = (comment.text && comment.text !== '🎨 Dibujo') ? comment.text : '';
        overlay.innerHTML = `
            <img src="${comment.drawing}" alt="Dibujo" />
            <div class="drawing-auto-hint">⏸ Espacio para reanudar</div>
            ${descText ? `<div class="drawing-auto-info">${descText}</div>` : ''}
            <button class="drawing-auto-close" title="Cerrar">✕</button>
        `;
        container.appendChild(overlay);

        overlay.querySelector('.drawing-auto-close').addEventListener('click', () => {
            overlay.remove();
        });
    }

    return { init, open, close, save, isActive, showDrawingOverlay,
             startPlaybackWatch, stopPlaybackWatch, hasPlaybackOverlays, dismissPlaybackOverlays };
})();
