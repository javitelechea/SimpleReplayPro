/* ═══════════════════════════════════════════
   SimpleReplay — Drawing Annotation Tool
   Canvas overlay on video for freehand drawing
   ═══════════════════════════════════════════ */

import { AppState } from './state.js';
import { YTPlayer } from './youtubePlayer.js';
import { PopoutController } from './popoutController.js';
import { t } from './i18n.js';
import {
    CIRCLE_FILL_OPACITY,
    frameScaleFromWidth,
    getVideoFrameMetricsFromElement,
    normalizePointInFrame,
    normalizeStrokeInFrame,
    normalizeStrokeListInFrame,
    paintOvalBBoxPreview,
    paintOvalFromPoints,
    paintStroke,
} from './drawingMirror.js';

export const DrawingTool = (() => {
    'use strict';

    const OVAL_CLICK_STAMP_THRESHOLD_PX = 10;

    let _canvas = null;
    let _ctx = null;
    let _toolbar = null;
    let _active = false;
    let _touchHandlersBound = false;
    let _drawing = false;
    let _playlistId = null;
    let _clipId = null;
    let _videoTimestamp = 0; // exact second in the video when drawing was started

    // Drawing state
    let _color = '#ff3b3b';
    let _lineWidth = 4;
    let _tool = 'pen'; // 'pen' | 'line' | 'arrow' | 'circle'
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
    let _presentationMode = false;
    let _popoutSyncScheduled = false;

    function _popoutDrawingConnected() {
        return !!(PopoutController && typeof PopoutController.isActive === 'function' && PopoutController.isActive());
    }

    function _mainVideoFrameMetrics() {
        const container = document.getElementById('player-container');
        return getVideoFrameMetricsFromElement(container);
    }

    function _ovalFrameScale() {
        return frameScaleFromWidth(_mainVideoFrameMetrics().width);
    }

    function _buildPopoutPreview(frame) {
        if (_lineMode && _lineStart) {
            if (_tool === 'circle') {
                return {
                    kind: 'circle',
                    color: _color,
                    fillOpacity: CIRCLE_FILL_OPACITY,
                    lineStart: normalizePointInFrame(_lineStart.x, _lineStart.y, frame),
                    point: null,
                };
            }
            return {
                kind: 'line',
                tool: _tool,
                color: _color,
                width: _lineWidth,
                lineStart: normalizePointInFrame(_lineStart.x, _lineStart.y, frame),
                point: null,
            };
        }
        if (_currentStroke && _currentStroke.points.length > 0) {
            return {
                kind: 'pen',
                stroke: normalizeStrokeInFrame(_currentStroke, frame),
            };
        }
        return null;
    }

    function _buildDrawingPopoutPayload(previewPoint = null) {
        const frame = _mainVideoFrameMetrics();
        let preview = _buildPopoutPreview(frame);
        if ((preview?.kind === 'line' || preview?.kind === 'circle') && previewPoint) {
            let stamp = false;
            if (preview?.kind === 'circle' && _lineStart) {
                const dist = Math.hypot(previewPoint.x - _lineStart.x, previewPoint.y - _lineStart.y);
                stamp = dist < OVAL_CLICK_STAMP_THRESHOLD_PX;
            }
            preview = {
                ...preview,
                point: stamp ? null : normalizePointInFrame(previewPoint.x, previewPoint.y, frame),
                stamp,
            };
        }
        return {
            active: true,
            space: 'video',
            videoAspect: frame.aspect,
            sourceFrame: {
                width: frame.width,
                height: frame.height,
            },
            strokes: normalizeStrokeListInFrame(_strokes, frame),
            preview,
        };
    }

    function _flushDrawingToPopout(previewPoint = null) {
        if (!_popoutDrawingConnected() || typeof PopoutController.notifyDrawing !== 'function') return;
        if (!_active || !_canvas) return;
        if (typeof PopoutController.ensureReady === 'function') PopoutController.ensureReady();
        PopoutController.notifyDrawing(_buildDrawingPopoutPayload(previewPoint));
    }

    function _syncDrawingToPopout(previewPoint = null) {
        if (!_popoutDrawingConnected() || typeof PopoutController.notifyDrawing !== 'function') return;
        if (!_active) {
            PopoutController.notifyDrawing({ active: false });
            return;
        }
        if (_popoutSyncScheduled) return;
        _popoutSyncScheduled = true;
        requestAnimationFrame(() => {
            _popoutSyncScheduled = false;
            _flushDrawingToPopout(previewPoint);
        });
    }

    function _clearPopoutDrawing() {
        if (!_popoutDrawingConnected() || typeof PopoutController.notifyDrawing !== 'function') return;
        PopoutController.notifyDrawing({ active: false });
    }

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

        // Toolbar buttons
        _toolbar.querySelector('[data-action="draw-save"]').addEventListener('click', save);
        _toolbar.querySelector('[data-action="draw-cancel"]').addEventListener('click', close);
        _toolbar.querySelector('[data-action="draw-clear"]').addEventListener('click', clearCanvas);
        _toolbar.querySelector('[data-action="draw-undo"]').addEventListener('click', undo);

        // Color swatches
        _toolbar.querySelectorAll('.draw-color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => _selectColor(swatch.dataset.color));
        });

        _toolbar.querySelector('[data-action="draw-pen"]').addEventListener('click', () => _selectTool('pen'));
        _toolbar.querySelector('[data-action="draw-line"]').addEventListener('click', () => _selectTool('line'));
        _toolbar.querySelector('[data-action="draw-arrow"]').addEventListener('click', () => _selectTool('arrow'));
        _toolbar.querySelector('[data-action="draw-circle"]').addEventListener('click', () => _selectTool('circle'));

        // Brush size
        const sizeSlider = _toolbar.querySelector('#draw-size');
        if (sizeSlider) {
            sizeSlider.addEventListener('input', () => {
                _lineWidth = parseInt(sizeSlider.value, 10);
            });
        }
    }

    function _applyToolbarMode() {
        if (!_toolbar) return;
        const actions = _toolbar.querySelector('.draw-toolbar-actions');
        const cancelBtn = _toolbar.querySelector('[data-action="draw-cancel"]');
        _toolbar.classList.toggle('presentation-mode', _presentationMode);
        if (_presentationMode) {
            if (actions) actions.style.display = 'none';
        } else {
            if (actions) actions.style.display = '';
        }
        if (cancelBtn) {
            cancelBtn.textContent = '✕';
            cancelBtn.title = t('draw.close');
            cancelBtn.setAttribute('aria-label', t('draw.closeAria'));
        }
    }

    const DRAW_SHORTCUT_COLORS = ['#ff3b3b', '#ffdd00', '#00d26a', '#0099ff', '#ffffff'];

    function _isDrawTextInput(target) {
        if (!target || typeof target.closest !== 'function') return false;
        return !!target.closest('#draw-author, #draw-description');
    }

    function _selectColor(color) {
        _color = color;
        _updateToolbar();
    }

    function _cycleColor() {
        const idx = DRAW_SHORTCUT_COLORS.indexOf(_color);
        const next = idx < 0 ? 0 : (idx + 1) % DRAW_SHORTCUT_COLORS.length;
        _selectColor(DRAW_SHORTCUT_COLORS[next]);
    }

    function _setTool(tool) {
        _tool = tool;
        _updateToolbar();
    }

    function _selectTool(tool) {
        if (tool === 'line' || tool === 'arrow' || tool === 'circle') {
            _tool = _tool === tool ? 'pen' : tool;
        } else {
            _tool = 'pen';
        }
        _updateToolbar();
    }

    function _adjustBrushSize(delta) {
        const sizeSlider = _toolbar && _toolbar.querySelector('#draw-size');
        const min = sizeSlider ? parseInt(sizeSlider.min, 10) : 2;
        const max = sizeSlider ? parseInt(sizeSlider.max, 10) : 12;
        _lineWidth = Math.min(max, Math.max(min, _lineWidth + delta));
        if (sizeSlider) sizeSlider.value = String(_lineWidth);
    }

    function _isPlayerFullscreen() {
        const container = document.getElementById('player-container');
        const nativeEl = document.fullscreenElement || document.webkitFullscreenElement || null;
        if (nativeEl === document.documentElement) return true;
        if (container && nativeEl === container) return true;
        return document.documentElement.classList.contains('sr-player-fs-active');
    }

    /** Ver + FS: Space limpia el lienzo, sale del dibujo y reanuda el video. */
    function _dismissViewFullscreenDrawingAndPlay() {
        clearCanvas();
        close();
        if (typeof YTPlayer !== 'undefined' && YTPlayer.play) YTPlayer.play();
    }

    function _onDrawingKeydown(e) {
        if (!_active) return;

        const key = (e.key || '').toLowerCase();
        const mod = e.metaKey || e.ctrlKey;

        if (_isDrawTextInput(e.target)) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                close();
                return;
            }
            if (mod && (key === 's' || e.key === 'Enter')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                save();
                return;
            }
            return;
        }

        let handled = false;

        if (
            (e.key === ' ' || e.key === 'Space')
            && AppState.get('mode') === 'view'
            && _isPlayerFullscreen()
        ) {
            _dismissViewFullscreenDrawingAndPlay();
            handled = true;
        } else if (e.key === 'Escape') {
            close();
            handled = true;
        } else if (mod && key === 's') {
            save();
            handled = true;
        } else if (mod && e.key === 'Enter') {
            save();
            handled = true;
        } else if (mod && key === 'z' && !e.shiftKey) {
            undo();
            handled = true;
        } else if (mod && !e.shiftKey && !e.altKey) {
            if (key === '1') {
                _cycleColor();
                handled = true;
            } else if (key === '2') {
                _setTool('pen');
                handled = true;
            } else if (key === '3') {
                _setTool('line');
                handled = true;
            } else if (key === '4') {
                _setTool('arrow');
                handled = true;
            } else if (key === '5') {
                _setTool('circle');
                handled = true;
            } else if (key === '7') {
                clearCanvas();
                handled = true;
            }
        } else if (key === '[') {
            _adjustBrushSize(-1);
            handled = true;
        } else if (key === ']') {
            _adjustBrushSize(1);
            handled = true;
        }

        // Bloquear 1–7 sueltos mientras dibujo activo (evita flags / atajos globales)
        if (!handled && !mod && !e.shiftKey && !e.altKey && key >= '1' && key <= '7') {
            handled = true;
        }

        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    /** Dibujo temporal para presentación (sin guardar en chat/playlist). */
    function openPresentation(playlistId = null, clipId = null) {
        open(playlistId, clipId, { presentation: true });
    }

    // ── Open drawing mode ──
    function open(playlistId, clipId, options = {}) {
        if (_active) return;
        _presentationMode = !!options.presentation;
        _playlistId = _presentationMode ? null : playlistId;
        _clipId = clipId || null;
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

        _bindTouchHandlers();

        // Show canvas & toolbar
        _canvas.classList.add('active');
        _toolbar.classList.add('active');
        const authorInput = _toolbar.querySelector('#draw-author');
        if (authorInput) {
            const preferred = AppState.getPreferredChatName ? AppState.getPreferredChatName() : t('js.defaultAnonymous');
            authorInput.value = preferred === 'Anónimo' ? '' : preferred;
        }

        // Clear
        _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        _updateToolbar();

        if (!_presentationMode) {
            const saveBtn = _toolbar.querySelector('[data-action="draw-save"]');
            if (saveBtn) {
                if (_playlistId) {
                    saveBtn.disabled = false;
                    saveBtn.style.opacity = '1';
                    saveBtn.style.cursor = 'pointer';
                    saveBtn.title = t('js.drawingSaveTooltip');
                } else {
                    saveBtn.disabled = true;
                    saveBtn.style.opacity = '0.35';
                    saveBtn.style.cursor = 'not-allowed';
                    saveBtn.title = t('js.drawingNeedPlaylist');
                }
            }
        }
        _applyToolbarMode();

        window.addEventListener('resize', _resizeCanvas);
        _flushDrawingToPopout();
        window.setTimeout(() => _flushDrawingToPopout(), 80);
    }

    // ── Close drawing mode (no save) ──
    function close() {
        if (!_active) return;
        _active = false;
        _presentationMode = false;
        _canvas.classList.remove('active');
        _toolbar.classList.remove('active');
        _toolbar.classList.remove('presentation-mode');
        _applyToolbarMode();
        window.removeEventListener('resize', _resizeCanvas);
        _unbindTouchHandlers();
        _strokes = [];
        _currentStroke = null;
        // Clear description field
        const descInput = _toolbar && _toolbar.querySelector('#draw-description');
        if (descInput) descInput.value = '';
        const authorInput = _toolbar && _toolbar.querySelector('#draw-author');
        if (authorInput) authorInput.value = '';
        _clearPopoutDrawing();
    }

    // ── Save drawing as comment ──
    function save() {
        if (!_active) return;
        if (_presentationMode) return;
        if (document.body.classList.contains('read-only-mode')) {
            UI.toast(t('toast.readOnlyNoSaveDrawing'), 'error');
            return;
        }
        if (!_playlistId) {
            UI.toast(t('toast.needPlaylistForDraw'), 'warning');
            return;
        }
        if (_strokes.length === 0) {
            UI.toast(t('toast.drawSomethingFirst'), 'error');
            return;
        }

        const dataUrl = _canvas.toDataURL('image/png');
        const authorInput = _toolbar && _toolbar.querySelector('#draw-author');
        let savedName = authorInput && authorInput.value ? authorInput.value.trim() : '';
        const isGuest = !AppState.get('authUser');
        const hasSavedChatName = (localStorage.getItem('sr_chat_name') || '').trim().length > 0;
        if (!savedName && isGuest && !hasSavedChatName) {
            const asked = window.prompt(t('prompt.chatName'), '') || '';
            savedName = asked.trim();
        }
        if (!savedName) {
            savedName = AppState.getPreferredChatName ? AppState.getPreferredChatName() : (localStorage.getItem('sr_chat_name') || t('js.defaultAnonymous'));
        }
        if (savedName && savedName !== 'Anónimo') {
            localStorage.setItem('sr_chat_name', savedName);
        }

        // Read description from toolbar input
        const descInput = _toolbar && _toolbar.querySelector('#draw-description');
        const description = descInput && descInput.value.trim() ? descInput.value.trim() : t('js.drawingLabel');

        AppState.addComment(_playlistId, _clipId, savedName, description, dataUrl, _videoTimestamp);

        // Always exit drawing mode right after a successful save.
        close();
        dismissPlaybackOverlays();
        dismissDrawingPreview();
        UI.toast(t('toast.drawingSaved'), 'success');
    }

    // ── Clear canvas ──
    function clearCanvas() {
        _strokes = [];
        _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        _syncDrawingToPopout();
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
        const scale = _ovalFrameScale();
        _strokes.forEach(stroke => {
            if (stroke.oval || stroke.circle) stroke._frameScale = scale;
            paintStroke(_ctx, stroke);
        });
        _ctx.globalCompositeOperation = 'source-over';
        _syncDrawingToPopout();
    }

    // ── Pointer events ──
    function _onPointerDown(e) {
        if (!_active) return;
        _drawing = true;
        const rect = _canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (e.shiftKey || _tool === 'line' || _tool === 'arrow' || _tool === 'circle') {
            _lineMode = true;
            _lineStart = { x, y };
            return;
        }

        _lineMode = false;
        _currentStroke = {
            color: _color,
            width: _lineWidth,
            eraser: false,
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
            _redraw();
            if (_tool === 'circle') {
                const dist = Math.hypot(x - _lineStart.x, y - _lineStart.y);
                const stamp = dist < OVAL_CLICK_STAMP_THRESHOLD_PX;
                if (stamp) {
                    paintOvalFromPoints(
                        _ctx,
                        _lineStart,
                        null,
                        _color,
                        CIRCLE_FILL_OPACITY,
                        _ovalFrameScale(),
                        true
                    );
                } else {
                    paintOvalBBoxPreview(
                        _ctx,
                        _lineStart,
                        { x, y },
                        _color,
                        CIRCLE_FILL_OPACITY,
                        _ovalFrameScale(),
                        false
                    );
                }
            } else {
                _ctx.beginPath();
                _ctx.strokeStyle = _color;
                _ctx.lineWidth = _lineWidth;
                _ctx.lineCap = 'round';
                _ctx.lineJoin = 'round';
                _ctx.globalCompositeOperation = 'source-over';
                if (_tool === 'arrow') {
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
            }
            _syncDrawingToPopout({ x, y });
            return;
        }

        if (!_currentStroke) return;
        _currentStroke.points.push({ x, y });
        _ctx.lineTo(x, y);
        _ctx.stroke();
        _ctx.beginPath();
        _ctx.moveTo(x, y);
        _syncDrawingToPopout();
    }

    function _onPointerUp(e) {
        if (!_drawing) return;
        _drawing = false;
        _ctx.globalCompositeOperation = 'source-over';

        if (_lineMode && _lineStart && e) {
            const rect = _canvas.getBoundingClientRect();
            const x = (e.clientX ?? _lineStart.x) - rect.left;
            const y = (e.clientY ?? _lineStart.y) - rect.top;
            if (_tool === 'circle') {
                const dist = Math.hypot(x - _lineStart.x, y - _lineStart.y);
                const stamp = dist < OVAL_CLICK_STAMP_THRESHOLD_PX;
                _strokes.push({
                    oval: true,
                    stamp,
                    color: _color,
                    fillOpacity: CIRCLE_FILL_OPACITY,
                    width: 0,
                    eraser: false,
                    points: stamp ? [{ x: _lineStart.x, y: _lineStart.y }] : [_lineStart, { x, y }],
                });
                _redraw();
            } else {
                _strokes.push({
                    color: _color,
                    width: _lineWidth,
                    eraser: false,
                    arrow: _tool === 'arrow',
                    points: [_lineStart, { x, y }],
                });
                _redraw();
            }
            _lineMode = false;
            _lineStart = null;
            return;
        }

        if (_currentStroke && _currentStroke.points.length > 1) {
            _strokes.push(_currentStroke);
            _redraw();
        }
        _currentStroke = null;
        _lineMode = false;
        _lineStart = null;
        _syncDrawingToPopout();
    }

    function _bindTouchHandlers() {
        if (!_canvas || _touchHandlersBound) return;
        _touchHandlersBound = true;
        _canvas.addEventListener('touchstart', _onTouchStart, { passive: false });
        _canvas.addEventListener('touchmove', _onTouchMove, { passive: false });
        _canvas.addEventListener('touchend', _onTouchEnd, { passive: true });
        _canvas.addEventListener('touchcancel', _onTouchEnd, { passive: true });
    }

    function _unbindTouchHandlers() {
        if (!_canvas || !_touchHandlersBound) return;
        _touchHandlersBound = false;
        _canvas.removeEventListener('touchstart', _onTouchStart);
        _canvas.removeEventListener('touchmove', _onTouchMove);
        _canvas.removeEventListener('touchend', _onTouchEnd);
        _canvas.removeEventListener('touchcancel', _onTouchEnd);
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
            swatch.classList.toggle('active', swatch.dataset.color === _color);
        });
        const penBtn = _toolbar.querySelector('[data-action="draw-pen"]');
        if (penBtn) penBtn.classList.toggle('active', _tool === 'pen');
        const lineBtn = _toolbar.querySelector('[data-action="draw-line"]');
        if (lineBtn) lineBtn.classList.toggle('active', _tool === 'line');
        const arrowBtn = _toolbar.querySelector('[data-action="draw-arrow"]');
        if (arrowBtn) arrowBtn.classList.toggle('active', _tool === 'arrow');
        const circleBtn = _toolbar.querySelector('[data-action="draw-circle"]');
        if (circleBtn) circleBtn.classList.toggle('active', _tool === 'circle');

        const sizeSlider = _toolbar.querySelector('#draw-size');
        if (sizeSlider) sizeSlider.value = _lineWidth;
    }

    /** Cierra el preview manual desde chat. Llamar al cambiar de clip / partido. */
    function dismissDrawingPreview() {
        const overlay = document.getElementById('drawing-preview-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.onclick = null;
            overlay.hidden = true;
        }
        document.getElementById('drawing-embed-blocker')?.remove();
    }

    // ── Show a saved drawing overlay on the video ──
    function showDrawingOverlay(dataUrl, videoTimeSec) {
        // Seek to the exact moment the drawing was made
        if (videoTimeSec !== undefined && videoTimeSec !== null) {
            YTPlayer.seekTo(videoTimeSec);
        }
        // Always freeze playback when opening a drawing preview.
        // (Some legacy comments have no timestamp; also guard against seek/play races.)
        YTPlayer.pause();
        setTimeout(() => {
            try { YTPlayer.pause(); } catch (_) { /* noop */ }
        }, 40);

        const pc = document.getElementById('player-container');
        if (!pc) return;

        let overlay = document.getElementById('drawing-preview-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'drawing-preview-overlay';
            overlay.className = 'drawing-preview-overlay';
            pc.appendChild(overlay);
        }
        document.getElementById('drawing-embed-blocker')?.remove();
        overlay.hidden = false;

        const closePreview = () => {
            dismissDrawingPreview();
        };

        overlay.innerHTML = `<img src="${dataUrl}" alt="Dibujo" /><button class="drawing-preview-close" title="Cerrar">✕</button>`;
        overlay.classList.add('active');

        overlay.querySelector('.drawing-preview-close').addEventListener('click', () => {
            closePreview();
        });

        // Click outside drawing to close (single handler; overlay is reused each open)
        overlay.onclick = (e) => {
            if (e.target === overlay) closePreview();
        };
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

            const t = YTPlayer.getUiCurrentTime
                ? YTPlayer.getUiCurrentTime()
                : YTPlayer.getCurrentTime();
            drawings.forEach(d => {
                const drawingKey = d.timestamp || `${d.videoTimeSec}|${d.text || ''}`;
                if (_watchShownIds.has(drawingKey)) return;
                if (d.videoTimeSec === undefined || d.videoTimeSec === null) return;
                if (t >= d.videoTimeSec) {
                    _watchShownIds.add(drawingKey);
                    // No rewind jump: pause right where playback is.
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
        dismissDrawingPreview();
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

    function syncPopoutMirror() {
        if (_active) _flushDrawingToPopout();
        else _clearPopoutDrawing();
    }

    // Capture antes que app.js: import de drawing.js ocurre al inicio de app.js
    document.addEventListener('keydown', _onDrawingKeydown, true);

    return { init, open, openPresentation, close, save, isActive, syncPopoutMirror, showDrawingOverlay,
             startPlaybackWatch, stopPlaybackWatch, hasPlaybackOverlays, dismissPlaybackOverlays,
             dismissDrawingPreview };
})();
