import { AppState } from './state.js';
import { YTPlayer } from './youtubePlayer.js';

export const Timeline = (() => {
    let _interval = null;
    let _isDragging = false;
    let _dragType = null; // 'playhead', 'clip-start', 'clip-end'
    let _dragClipId = null;
    let _lastDragSeekTs = 0;

    let _timelineEl, _trackEl, _progressEl, _playheadEl, _timeLabelEl, _clipsContainerEl;
    let _timeStartEl, _timeEndEl;

    function init() {
        _timelineEl = document.getElementById('custom-timeline');
        _trackEl = _timelineEl ? _timelineEl.querySelector('.timeline-track') : null;
        _progressEl = document.getElementById('timeline-progress');
        _playheadEl = document.getElementById('timeline-playhead');
        _timeLabelEl = document.getElementById('playhead-time');
        _timeStartEl = document.getElementById('timeline-time-start');
        _timeEndEl = document.getElementById('timeline-time-end');
        _clipsContainerEl = document.getElementById('timeline-clips');

        if (!_timelineEl) return;

        _timelineEl.classList.remove('hidden');

        // Start polling
        _interval = setInterval(update, 100);

        // Event listeners
        _timelineEl.addEventListener('mousedown', onMouseDown);
        _timelineEl.addEventListener('touchstart', onTouchStart, { passive: false });
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
        document.addEventListener('touchcancel', onTouchEnd);

        // Listen for state changes to re-render clips
        AppState.on('clipsUpdated', renderClips);
        AppState.on('clipChanged', renderClips);
        AppState.on('viewFiltersChanged', renderClips);
        AppState.on('gameChanged', () => setTimeout(renderClips, 1000));
    }

    // Helper to get the start and end seconds of the currently "visible" timeline.
    // If a clip is selected, we zoom into [clipStart - 5s, clipEnd + 5s] (clamped al medio disponible).
    // Si no clip: [0, duration].
    function getTimelineBounds() {
        let duration = 0;
        if (typeof YTPlayer !== 'undefined' && YTPlayer.isReady()) {
            duration = YTPlayer.getDuration();
        }
        const durSafe = Number.isFinite(duration) && duration > 0 ? duration : 0;

        const currentClipId = AppState.get('currentClipId');
        // Vista centrada en el clip: la duración del player puede ir por detrás del clip (vivo,
        // WebM sin metadata aún). Antes: zoomEnd = min(duration, end+5) achicaba la ventana y
        // el segmento del clip superaba el 100 % del ancho.
        if (currentClipId) {
            let clip = AppState.get('clips').find((c) => c.id === currentClipId);
            if (!clip && typeof AppState.getCurrentClip === 'function') {
                clip = AppState.getCurrentClip();
            }
            if (clip) {
                const pad = 5;
                const zoomStart = Math.max(0, clip.start_sec - pad);
                const zoomEndIdeal = clip.end_sec + pad;
                const zoomEnd = Math.max(zoomEndIdeal, Math.min(durSafe, zoomEndIdeal));
                const span = zoomEnd - zoomStart;
                if (span > 0) {
                    return { start: zoomStart, end: zoomEnd, duration: span };
                }
            }
        }

        return { start: 0, end: durSafe, duration: durSafe };
    }

    function formatTime(sec) {
        if (!sec || isNaN(sec)) return "0:00";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function update() {
        if (_isDragging && _dragType === 'playhead') return; // skip playhead update if dragging it
        if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady()) return;

        try {
            const current = YTPlayer.getUiCurrentTime
                ? YTPlayer.getUiCurrentTime()
                : YTPlayer.getCurrentTime();
            const bounds = getTimelineBounds();

            if (bounds.duration > 0) {
                // If current time is before the zoomed window or after the zoomed window,
                // we still update the time label, but the percent cap to 0-100 handles it visually.
                // However, hiding it when completely out of bounds could be good, but capping is safer.
                const percent = ((current - bounds.start) / bounds.duration) * 100;
                updatePlayhead(percent, current);
            }
            updateEdgeTimes(bounds);
        } catch (e) { }
    }

    function updateEdgeTimes(bounds) {
        if (!_timeStartEl && !_timeEndEl) return;
        const b = bounds || getTimelineBounds();
        if (_timeStartEl) _timeStartEl.textContent = formatTime(b.start);
        if (_timeEndEl) {
            let endSec = b.end;
            if (typeof YTPlayer !== 'undefined' && YTPlayer.isReady()) {
                const dur = YTPlayer.getDuration();
                if (Number.isFinite(dur) && dur > 0) endSec = dur;
            }
            _timeEndEl.textContent = formatTime(endSec);
        }
    }

    function applyPlayheadEdgeStyles(percent) {
        const p = Math.max(0, Math.min(100, percent));
        let leftPct = p;
        let playheadTransform = 'translateX(-50%)';
        if (p <= 0.5) {
            leftPct = 0;
            playheadTransform = 'translateX(0)';
        } else if (p >= 99.5) {
            leftPct = 100;
            playheadTransform = 'translateX(-100%)';
        }
        _playheadEl.style.left = `${leftPct}%`;
        _playheadEl.style.transform = playheadTransform;

        if (!_timeLabelEl) return;
        if (p <= 3) {
            _timeLabelEl.style.left = '0';
            _timeLabelEl.style.transform = 'translateX(0)';
        } else if (p >= 97) {
            _timeLabelEl.style.left = '100%';
            _timeLabelEl.style.transform = 'translateX(-100%)';
        } else {
            _timeLabelEl.style.left = '50%';
            _timeLabelEl.style.transform = 'translateX(-50%)';
        }
    }

    function updatePlayhead(percent, currentSec) {
        if (!_progressEl || !_playheadEl) return;

        // Hide playhead if it's outside the zoomed view bounds entirely (less than 0 or more than 100)
        if (percent < 0 || percent > 100) {
            _playheadEl.style.display = 'none';
            _progressEl.style.width = '0%';
        } else {
            _playheadEl.style.display = 'block';
            const progressPct = Math.max(0, Math.min(100, percent));
            _progressEl.style.width = `${progressPct}%`;
            applyPlayheadEdgeStyles(progressPct);
        }

        if (_timeLabelEl) {
            _timeLabelEl.textContent = formatTime(currentSec);
        }
    }

    function getSecFromEvent(e) {
        if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady()) return 0;
        const rect = (_trackEl || _timelineEl).getBoundingClientRect();
        const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX ?? 0;
        let x = clientX - rect.left;
        x = Math.max(0, Math.min(x, rect.width));
        const percent = x / rect.width;

        const bounds = getTimelineBounds();
        return bounds.start + (percent * bounds.duration);
    }

    function beginScrub(e) {
        if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady()) return;
        if (e.button !== undefined && e.button !== 0) return;

        // Scrub manual: no auto-pausa al fin del clip (playlist/colección).
        if (typeof YTPlayer.clearClipEnd === 'function') {
            YTPlayer.clearClipEnd();
        }

        _isDragging = true;
        _dragType = 'playhead';
        _lastDragSeekTs = 0;

        const sec = getSecFromEvent(e);
        YTPlayer.seekTo(sec);

        const bounds = getTimelineBounds();
        if (bounds.duration > 0) {
            updatePlayhead(((sec - bounds.start) / bounds.duration) * 100, sec);
        }
    }

    function onMouseDown(e) {
        beginScrub(e);
    }

    function onTouchStart(e) {
        if (!_timelineEl?.contains(e.target)) return;
        e.preventDefault();
        beginScrub(e);
    }

    function onTouchMove(e) {
        if (!_isDragging) return;
        e.preventDefault();
        onMouseMove(e);
    }

    function onTouchEnd(e) {
        if (!_isDragging) return;
        onMouseUp(e);
    }

    function onMouseMove(e) {
        if (!_isDragging || _dragType !== 'playhead') return;
        const now = performance.now();
        // Throttle seeks while dragging to keep it smooth and stable.
        if (now - _lastDragSeekTs < 28) return;
        _lastDragSeekTs = now;

        const sec = getSecFromEvent(e);
        const bounds = getTimelineBounds();
        if (bounds.duration <= 0) return;
        YTPlayer.seekTo(sec);
        updatePlayhead(((sec - bounds.start) / bounds.duration) * 100, sec);
    }

    function onMouseUp(e) {
        if (!_isDragging) return;

        // Final precise seek on release
        const sec = getSecFromEvent(e);
        const bounds = getTimelineBounds();
        if (bounds.duration > 0) {
            YTPlayer.seekTo(sec);
            updatePlayhead(((sec - bounds.start) / bounds.duration) * 100, sec);
        }
        _isDragging = false;
        _dragType = null;
        _dragClipId = null;
        _lastDragSeekTs = 0;
    }

    function renderClips() {
        if (!_clipsContainerEl) return;
        _clipsContainerEl.innerHTML = '';

        if (typeof YTPlayer === 'undefined' || !YTPlayer.isReady()) {
            setTimeout(renderClips, 1000); // retry if player not ready
            return;
        }

        const bounds = getTimelineBounds();
        if (bounds.duration <= 0) {
            setTimeout(renderClips, 1000); // try again later if metadata isn't fully loaded
            return;
        }

        const clips = AppState.getFilteredClips();

        const currentClipId = AppState.get('currentClipId');

        clips.forEach(clip => {
            // Only render clips that overlap with the current bounds
            if (clip.end_sec < bounds.start || clip.start_sec > bounds.end) {
                return; // Clip is outside the visible timeline window
            }

            // HIDE other clips when zoomed in to focus ONLY on the active clip's boundaries
            if (currentClipId && clip.id !== currentClipId) {
                return;
            }

            const leftPct = ((clip.start_sec - bounds.start) / bounds.duration) * 100;
            const widthPct = ((clip.end_sec - clip.start_sec) / bounds.duration) * 100;

            const el = document.createElement('div');
            el.className = 'timeline-clip-segment';
            el.dataset.clipId = clip.id;

            // Check if it's a rival clip to add the red color class
            const tag = AppState.getTagType(clip.tag_type_id);
            if (tag && tag.row === 'bottom') {
                el.classList.add('rival');
            }

            // Allow clips to graphically overflow if they stretch beyond the bounds, which looks natural
            el.style.left = `${leftPct}%`;
            el.style.width = `${widthPct}%`;

            // Active clip glows more
            if (clip.id === currentClipId) {
                el.style.background = 'var(--accent)';
                el.style.zIndex = '5';
            }

            // Keep segment visual-only so any click on timeline seeks to exact point.
            el.style.pointerEvents = 'none';

            _clipsContainerEl.appendChild(el);
        });
        updateEdgeTimes(bounds);
    }

    return { init, renderClips };
})();

// Provide it globally
window.Timeline = Timeline;
