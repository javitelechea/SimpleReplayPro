/* ═══════════════════════════════════════════
   SimpleReplay — UI Rendering
   All DOM rendering and update functions
   ═══════════════════════════════════════════ */

import { AppState } from './state.js';
import { YTPlayer } from './youtubePlayer.js';
import { DrawingTool } from './drawing.js';
import { FirebaseData } from './firebaseData.js';
import { ExportManager } from './export.js';
import { ClipExport } from './clipExport.js';

export const UI = (() => {
    const HOTKEY_OPTIONS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

    /** Botón: clic → siguiente tecla A–Z queda como atajo; muestra la letra o — */
    function bindButtonboardHotkeyCapture(btn, { getValue, setValue, onUpdated }) {
        if (!btn) return;

        function hotkeyLabel(v) {
            const s = String(v || '').trim().toUpperCase();
            return /^[A-Z]$/.test(s) ? s : '—';
        }

        function sync() {
            const raw = (getValue() || '').trim().toUpperCase();
            const letter = /^[A-Z]$/.test(raw) ? raw : '';
            btn.dataset.hotkey = letter;
            btn.textContent = hotkeyLabel(letter);
            btn.title = letter
                ? `Atajo: ${letter}. Clic para cambiar.`
                : 'Clic y luego una letra (A–Z). Retroceso: sin tecla. Esc: cancelar.';
        }

        sync();

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.dataset.bbListening === '1') return;

            const prevRaw = (getValue() || '').trim().toUpperCase();
            const prevLetter = /^[A-Z]$/.test(prevRaw) ? prevRaw : '';

            btn.dataset.bbListening = '1';
            btn.classList.add('bb-hotkey-capture--listening');
            btn.textContent = '…';

            function detach() {
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onPointer, true);
                btn.dataset.bbListening = '0';
                btn.classList.remove('bb-hotkey-capture--listening');
            }

            function onPointer(pe) {
                if (btn.contains(pe.target)) return;
                detach();
                setValue(prevLetter);
                sync();
            }

            function onKey(ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.key === 'Escape') {
                    detach();
                    setValue(prevLetter);
                    sync();
                    return;
                }
                let next = null;
                if (ev.key === 'Backspace' || ev.key === 'Delete') {
                    next = '';
                } else if (ev.key.length === 1) {
                    const u = ev.key.toUpperCase();
                    if (u >= 'A' && u <= 'Z') next = u;
                }
                if (next === null) return;

                detach();
                setValue(next);
                sync();
                if (typeof onUpdated === 'function') onUpdated();
            }

            document.addEventListener('keydown', onKey, true);
            requestAnimationFrame(() => {
                document.addEventListener('pointerdown', onPointer, true);
            });
        });
    }

    const FLAG_EMOJI = {
        bueno: '👍',
        acorregir: '⚠️',
        duda: '❓',
        importante: '⭐'
    };

    const FLAG_LABELS = {
        bueno: 'Bueno',
        acorregir: 'A corregir',
        duda: 'Duda',
        importante: 'Importante'
    };

    // ── Helpers ──
    function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }

    // ── Toast ──
    function toast(msg, type = '') {
        const container = $('#toast-container');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = msg;
        container.appendChild(el);
        setTimeout(() => { if (el.parentNode) el.remove(); }, 2600);
    }

    // ═══ PROJECT TITLE ═══
    function updateProjectTitle() {
        const titleEl = $('#current-project-title');
        if (!titleEl) return;
        const currentId = AppState.get('currentGameId');
        const games = AppState.get('games');
        const game = games.find(g => g.id === currentId);

        const relinkBtn = $('#btn-relink-video');
        if (game) {
            titleEl.textContent = game.title;
            // Show relink button if it's a local video project (no YouTube ID)
            if (relinkBtn) relinkBtn.style.display = (!game.youtube_video_id) ? '' : 'none';
        } else {
            titleEl.textContent = '';
            if (relinkBtn) relinkBtn.style.display = 'none';
        }
    }

    // ═══ TAG BUTTONS (Below Video — Top & Bottom rows) ═══
    let _tagEditMode = false;
    let _editingTagId = null;

    function renderTagButtons() {
        const containerTop = $('#tag-buttons-a');
        const containerBottom = $('#tag-buttons-b');
        const tags = AppState.get('tagTypes');
        containerTop.innerHTML = '';
        containerBottom.innerHTML = '';

        const topRowKeys = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'];
        const bottomRowKeys = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'];

        let topIdx = 0;
        let bottomIdx = 0;

        function createTagBtn(tag) {
            const btn = document.createElement('button');
            const isRival = tag.row === 'bottom';
            let hotkey = '';
            const customHotkey = String(tag.hotkey || '').trim().toUpperCase();

            // Skip hotkeys for special tags like "Start"
            if (!_tagEditMode && tag.id !== 'tag-start') {
                if (customHotkey) {
                    hotkey = customHotkey;
                } else if (!isRival && topIdx < topRowKeys.length) {
                    hotkey = topRowKeys[topIdx++];
                } else if (isRival && bottomIdx < bottomRowKeys.length) {
                    hotkey = bottomRowKeys[bottomIdx++];
                }
            }

            btn.className = 'tag-btn' + (isRival ? ' tag-btn-rival' : '') +
                (tag.id === 'tag-start' ? ' tag-btn-small' : '') +
                (_tagEditMode ? ' tag-edit-mode' : '') +
                (_editingTagId === tag.id ? ' tag-editing' : '');
            btn.dataset.tagId = tag.id;

            if (hotkey) {
                btn.innerHTML = `<span>${tag.label}</span><span class="tag-hotkey-hint" style="font-size:0.65rem; opacity:0.6; margin-left:4px;">[${hotkey}]</span>`;
                btn.dataset.hotkey = hotkey.toLowerCase();
            } else {
                btn.textContent = tag.label;
            }

            btn.title = _tagEditMode
                ? `Click para editar "${tag.label}"`
                : `${tag.label} — Pre: ${tag.pre_sec}s | Post: ${tag.post_sec}s${hotkey ? ` | Hotkey: ${hotkey}` : ''}`;

            btn.addEventListener('click', () => {
                if (_tagEditMode) {
                    openTagInlineEditor(tag);
                    return;
                }
                // Normal mode: create clip
                if (!AppState.get('currentGameId')) {
                    toast('Primero seleccioná un partido', 'error');
                    return;
                }
                const tSec = Math.round(YTPlayer.getCurrentTime());
                const clip = AppState.addClip(tag.id, tSec);
                if (clip) {
                    btn.classList.add('tag-flash');
                    setTimeout(() => btn.classList.remove('tag-flash'), 500);
                    toast(`Clip creado: ${tag.label} @ ${formatTime(tSec)}`, 'success');

                    // Auto-scroll to the newly created clip
                    const clipEl = document.querySelector(`.clip-item[data-clip-id="${clip.id}"]`);
                    if (clipEl) {
                        clipEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            });
            return btn;
        }

        tags.filter(t => !t.isHidden).forEach(tag => {
            if (tag.row === 'bottom') {
                containerBottom.appendChild(createTagBtn(tag));
            } else {
                containerTop.appendChild(createTagBtn(tag));
            }
        });

        // In edit mode, add "+" buttons for adding new tags to each row
        if (_tagEditMode) {
            const addBtnTop = document.createElement('button');
            addBtnTop.className = 'tag-btn tag-btn-add';
            addBtnTop.textContent = '+';
            addBtnTop.title = 'Agregar tag (propio)';
            addBtnTop.addEventListener('click', () => openTagInlineEditor(null, 'top'));
            containerTop.appendChild(addBtnTop);

            const addBtnBottom = document.createElement('button');
            addBtnBottom.className = 'tag-btn tag-btn-rival tag-btn-add';
            addBtnBottom.textContent = '+';
            addBtnBottom.title = 'Agregar tag (rival)';
            addBtnBottom.addEventListener('click', () => openTagInlineEditor(null, 'bottom'));
            containerBottom.appendChild(addBtnBottom);
        }
    }

    // ═══ FLAG DROPDOWN HELPERS (per-clip flag assignment) ═══
    function buildFlagButton(clipId, activeFlags) {
        const hasFlags = activeFlags.length > 0;
        const flagsDisplay = hasFlags ? activeFlags.map(f => FLAG_EMOJI[f] || '').join('') : '';
        return `<span class="clip-flags-display">${flagsDisplay}</span><button class="clip-flag-btn${hasFlags ? ' has-flags' : ''}" data-clip-id="${clipId}" title="Flags">🚩</button>`;
    }

    function attachFlagDropdownHandlers(container, rerenderFn) {
        container.querySelectorAll('.clip-flag-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const clipId = btn.dataset.clipId;
                // Close any other open popover
                container.querySelectorAll('.flag-popover').forEach(p => p.remove());
                // Create popover
                const popover = document.createElement('div');
                popover.className = 'flag-popover';
                const allFlags = ['bueno', 'acorregir', 'duda', 'importante'];
                const currentFlags = AppState.getClipUserFlags(clipId);
                popover.innerHTML = allFlags.map(flag => {
                    const isActive = currentFlags.includes(flag);
                    return `<button class="flag-popover-btn${isActive ? ' active' : ''}" data-clip-id="${clipId}" data-flag="${flag}" title="${FLAG_LABELS[flag]}">${FLAG_EMOJI[flag]}</button>`;
                }).join('');
                btn.parentElement.style.position = 'relative';
                btn.parentElement.appendChild(popover);
                // Attach flag click handlers
                popover.querySelectorAll('.flag-popover-btn').forEach(fb => {
                    fb.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        AppState.toggleFlag(fb.dataset.clipId, fb.dataset.flag);
                        rerenderFn();
                    });
                });
                // Close on outside click
                const close = (ev) => {
                    if (!popover.contains(ev.target) && ev.target !== btn) {
                        popover.remove();
                        document.removeEventListener('click', close);
                    }
                };
                setTimeout(() => document.addEventListener('click', close), 0);
            });
        });
    }

    // ═══ CHAT / COMMENTS HELPERS ═══
    const MENTION_REGEX = /@(\w[\w\s]*?)(?=\s|$|[.,;:!?])/g;

    function getDefaultChatDisplayName() {
        const auth = AppState.get('authUser');
        if (auth) {
            const fromAuth = (auth.displayName || auth.email || '').trim();
            if (fromAuth) return fromAuth;
        }
        return (localStorage.getItem('sr_chat_name') || '').trim();
    }

    function escapeChatAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function highlightMentions(text) {
        return text.replace(MENTION_REGEX, '<span class="chat-mention">@$1</span>');
    }

    function buildChatButton(playlistId, clipId) {
        if (!playlistId) return ''; // Chat only in playlists
        const comments = AppState.getComments(playlistId, clipId);
        const count = comments.length;
        const hasClass = count > 0 ? ' has-comments' : '';
        return `<button class="clip-chat-btn${hasClass}" data-clip-id="${clipId}" data-playlist-id="${playlistId}" title="Chat (${count})">💬${count > 0 ? count : ''}</button>`;
    }

    function buildDrawButton(playlistId, clipId) {
        if (!playlistId) return ''; // Draw only in playlists
        const comments = AppState.getComments(playlistId, clipId);
        const drawCount = comments.filter(c => c.drawing).length;
        const hasClass = drawCount > 0 ? ' has-drawings' : '';
        return `<button class="clip-draw-btn${hasClass}" data-clip-id="${clipId}" data-playlist-id="${playlistId}" title="Dibujar (${drawCount})">🎨${drawCount > 0 ? drawCount : ''}</button>`;
    }

    function buildChatPanel(playlistId, clipId) {
        const comments = AppState.getComments(playlistId, clipId);
        const savedName = escapeChatAttr(getDefaultChatDisplayName());
        let messagesHtml = '';
        if (comments.length === 0) {
            messagesHtml = '<p style="color:var(--text-muted);font-size:0.7rem;text-align:center;">Sin comentarios</p>';
        } else {
            messagesHtml = comments.map(c => {
                const time = c.timestamp ? new Date(c.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
                if (c.drawing) {
                    const label = (c.text && c.text !== '🎨 Dibujo') ? c.text : 'Dibujo';
                    const timePart = (c.videoTimeSec !== null && c.videoTimeSec !== undefined)
                        ? ` @ ${formatTime(c.videoTimeSec)}` : '';
                    return `<div class="chat-message" data-drawing-ts="${c.timestamp}"><span class="chat-name">${c.name}:</span>🎨 ${label}${timePart}<button class="drawing-delete-btn" data-playlist-id="${playlistId}" data-clip-id="${clipId}" data-ts="${c.timestamp}" title="Borrar dibujo">🗑️</button><span class="chat-time">${time}</span></div>`;
                }
                return `<div class="chat-message"><span class="chat-name">${c.name}:</span>${highlightMentions(c.text)}<span class="chat-time">${time}</span></div>`;
            }).join('');
        }
        return `
        <div class="clip-chat-panel" data-clip-id="${clipId}" data-playlist-id="${playlistId}">
            <div class="chat-messages">${messagesHtml}</div>
            <div class="chat-input-row">
                <input type="text" class="chat-name-input" placeholder="Nombre" value="${savedName}" data-role="chat-name" />
                <input type="text" class="chat-text-input" placeholder="Mensaje... (@Arq, @Del...)" data-role="chat-text" />
                <button class="btn btn-xs btn-primary chat-send-btn" data-clip-id="${clipId}" data-playlist-id="${playlistId}">↩</button>
            </div>
        </div>`;
    }

    function toggleChatPanelForClip(playlistId, clipId) {
        if (!playlistId) return;

        const mode = AppState.get('mode');
        const listContainer = mode === 'analyze' ? $('#analyze-clip-list') : $('#view-clip-list');
        if (!listContainer) return;

        const parentEl = Array.from(listContainer.querySelectorAll('.clip-item')).find(el => el.dataset.clipId === clipId);
        if (!parentEl) return;

        const existing = parentEl.querySelector('.clip-chat-panel');
        if (existing) {
            existing.remove();
        } else {
            // Close any other open chat
            $$('.clip-chat-panel').forEach(p => p.remove());
            parentEl.insertAdjacentHTML('beforeend', buildChatPanel(playlistId, clipId));

            // Focus text input
            const textInput = parentEl.querySelector('.chat-text-input');
            if (textInput) textInput.focus();

            // Send handler
            const sendBtn = parentEl.querySelector('.chat-send-btn');
            const nameInput = parentEl.querySelector('.chat-name-input');
            const panel = parentEl.querySelector('.clip-chat-panel');

            const closeChat = (ev) => {
                if (panel && !panel.contains(ev.target) && !ev.target.closest('#btn-clip-chat') && !ev.target.closest('.clip-chat-btn')) {
                    panel.remove();
                    document.removeEventListener('click', closeChat);
                }
            };
            setTimeout(() => document.addEventListener('click', closeChat), 10);

            const sendMessage = () => {
                const name = nameInput.value.trim();
                const text = textInput.value.trim();
                if (!name) { toast('Escribí tu nombre', 'error'); nameInput.focus(); return; }
                if (!text) return;
                localStorage.setItem('sr_chat_name', name);
                AppState.addComment(playlistId, clipId, name, text);
                document.removeEventListener('click', closeChat);
                const mode = AppState.get('mode');
                if (mode === 'analyze') {
                    renderAnalyzeClips();
                } else {
                    renderViewClips();
                }
                updateClipEditControls();
            };
            sendBtn.addEventListener('click', sendMessage);
            textInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); sendMessage(); }
            });

            // Drawing delete handlers
            panel.querySelectorAll('.drawing-delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!confirm('¿Borrar este dibujo?')) return;
                    AppState.removeComment(btn.dataset.playlistId, btn.dataset.clipId, btn.dataset.ts);
                    const mode = AppState.get('mode');
                    if (mode === 'analyze') renderAnalyzeClips(); else renderViewClips();
                    updateClipEditControls();
                });
            });
        }
    }

    // ═══ VIDEO CHAT OVERLAY ═══
    function showVideoChatPanel(playlistId, clipId) {
        const panel = $('#video-chat-panel');
        if (!panel || !playlistId || !clipId) return;

        const comments = AppState.getComments(playlistId, clipId);
        const savedName = escapeChatAttr(getDefaultChatDisplayName());
        let messagesHtml = '';
        if (comments.length === 0) {
            messagesHtml = '<p style="color:rgba(255,255,255,0.5);font-size:0.7rem;text-align:center;">Sin comentarios</p>';
        } else {
            messagesHtml = comments.map(c => {
                const time = c.timestamp ? new Date(c.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
                if (c.drawing) {
                    const label = (c.text && c.text !== '🎨 Dibujo') ? c.text : 'Dibujo';
                    const timePart = (c.videoTimeSec !== null && c.videoTimeSec !== undefined)
                        ? ` @ ${formatTime(c.videoTimeSec)}` : '';
                    return `<div class="chat-message" data-drawing-ts="${c.timestamp}"><span class="chat-name">${c.name}:</span>🎨 ${label}${timePart}<button class="drawing-delete-btn" data-playlist-id="${playlistId}" data-clip-id="${clipId}" data-ts="${c.timestamp}" title="Borrar dibujo">🗑️</button><span class="chat-time">${time}</span></div>`;
                }
                return `<div class="chat-message"><span class="chat-name">${c.name}:</span>${highlightMentions(c.text)}<span class="chat-time">${time}</span></div>`;
            }).join('');
        }

        panel.innerHTML = `
            <div class="chat-messages">${messagesHtml}</div>
            <div class="chat-input-row">
                <input type="text" class="chat-name-input" placeholder="Nombre" value="${savedName}" data-role="chat-name" />
                <input type="text" class="chat-text-input" placeholder="Mensaje..." data-role="chat-text" />
                <button class="btn btn-xs btn-primary chat-send-btn" data-clip-id="${clipId}" data-playlist-id="${playlistId}">↩</button>
            </div>
        `;
        panel.style.display = 'block';

        // Auto-scroll chat messages to the newest (bottom)
        const messagesEl = panel.querySelector('.chat-messages');
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;

            // Show a top fade indicator when there are more messages above
            if (messagesEl.scrollHeight > messagesEl.clientHeight) {
                messagesEl.classList.add('has-more-above');
            }
            messagesEl.addEventListener('scroll', () => {
                if (messagesEl.scrollTop > 10) {
                    messagesEl.classList.add('has-more-above');
                } else {
                    messagesEl.classList.remove('has-more-above');
                }
            });
        }

        // Focus text input
        const textInput = panel.querySelector('.chat-text-input');
        if (textInput) textInput.focus();

        // Send handler
        const sendBtn = panel.querySelector('.chat-send-btn');
        const nameInput = panel.querySelector('.chat-name-input');
        const sendMessage = () => {
            const name = nameInput.value.trim();
            const text = textInput.value.trim();
            if (!name) { toast('Escribí tu nombre', 'error'); nameInput.focus(); return; }
            if (!text) return;
            localStorage.setItem('sr_chat_name', name);
            AppState.addComment(playlistId, clipId, name, text);
            // Re-render the panel with the new comment
            showVideoChatPanel(playlistId, clipId);
        };
        sendBtn.addEventListener('click', sendMessage);
        textInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); sendMessage(); }
        });

        // Drawing delete handlers
        panel.querySelectorAll('.drawing-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm('¿Borrar este dibujo?')) return;
                AppState.removeComment(btn.dataset.playlistId, btn.dataset.clipId, btn.dataset.ts);
                showVideoChatPanel(playlistId, clipId);
                AppState.saveToCloud().catch(() => {});
            });
        });
    }

    function hideVideoChatPanel() {
        const panel = $('#video-chat-panel');
        if (panel) {
            panel.style.display = 'none';
            panel.innerHTML = '';
        }
    }

    function attachChatHandlers(container, rerenderFn) {
        // Toggle chat panel on small specific clip button — now opens clip + video overlay
        container.querySelectorAll('.clip-chat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const clipId = btn.dataset.clipId;
                const playlistId = btn.dataset.playlistId;
                if (!playlistId) {
                    toast('El clip debe estar en una Playlist para usar el Chat', 'warning');
                    return;
                }
                // Select clip and play it
                const clip = AppState.get('clips').find(c => c.id === clipId);
                if (clip) {
                    AppState.setCurrentClip(clipId);
                    YTPlayer.playClip(clip.start_sec, clip.end_sec);
                }
                // Open chat overlay on video
                showVideoChatPanel(playlistId, clipId);
            });
        });

        // Draw button click handlers
        container.querySelectorAll('.clip-draw-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const clipId = btn.dataset.clipId;
                const playlistId = btn.dataset.playlistId || null;
                AppState.setCurrentClip(clipId);
                DrawingTool.open(playlistId, clipId);
            });
        });
    }

    // ═══ CLIP EXPORT helpers ═══
    function _isLocalProject() {
        const game = AppState.getCurrentGame();
        return !!(game && game.local_video_url);
    }

    function _getLocalVideoUrl() {
        const game = AppState.getCurrentGame();
        return game ? game.local_video_url : null;
    }

    function _showExportProgress(msg) {
        const bar = $('#export-progress');
        const txt = $('#export-progress-text');
        if (!bar || !txt) return;
        if (msg) {
            txt.textContent = msg;
            bar.style.display = 'flex';
        } else {
            bar.style.display = 'none';
            txt.textContent = '';
        }
    }

    async function _handleClipExport(btn, clip, tag) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('clip-export-busy');
        const origText = btn.textContent;
        btn.textContent = '⏳';
        try {
            const label = tag ? tag.label : 'clip';
            await ClipExport.exportClip(
                _getLocalVideoUrl(),
                clip.start_sec,
                clip.end_sec,
                label,
                _showExportProgress
            );
            toast('Clip exportado ✅', 'success');
        } catch (err) {
            console.error('Export clip error:', err);
            toast('Error al exportar clip', 'error');
        } finally {
            _showExportProgress(null);
            btn.disabled = false;
            btn.classList.remove('clip-export-busy');
            btn.textContent = origText;
            btn.title = 'Exportar clip MP4';
        }
    }

    async function _handlePlaylistExport(btn, playlistId, playlistName) {
        if (btn.disabled) return;
        const items = AppState.get('playlistItems')[playlistId] || [];
        if (items.length === 0) { toast('La playlist no tiene clips', 'error'); return; }

        btn.disabled = true;
        btn.classList.add('clip-export-busy');
        const origText = btn.textContent;
        btn.textContent = '⏳';
        try {
            const allClips = AppState.get('clips');
            const segments = items.map(clipId => {
                const c = allClips.find(x => x.id === clipId);
                return c ? { startSec: c.start_sec, endSec: c.end_sec } : null;
            }).filter(Boolean);

            await ClipExport.exportPlaylist(
                _getLocalVideoUrl(),
                segments,
                playlistName || 'playlist',
                _showExportProgress
            );
            toast('Playlist exportada ✅', 'success');
        } catch (err) {
            console.error('Export playlist error:', err);
            toast('Error al exportar playlist', 'error');
        } finally {
            _showExportProgress(null);
            btn.disabled = false;
            btn.classList.remove('clip-export-busy');
            btn.textContent = origText;
            btn.title = 'Exportar playlist MP4';
        }
    }

    // ═══ CLIP LIST (Analyze) ═══
    function renderAnalyzeClips() {
        const container = $('#analyze-clip-list');
        const clips = AppState.get('clips');
        const currentClipId = AppState.get('currentClipId');
        const isLocal = _isLocalProject();

        container.innerHTML = '';
        $('#clip-count').textContent = clips.length;

        if (clips.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;padding:8px;">Sin clips. Usá los tags para crear.</p>';
            return;
        }

        clips.forEach(clip => {
            const tag = AppState.getTagType(clip.tag_type_id);
            const clipNum = AppState.getClipNumber(clip);
            const flags = AppState.getClipUserFlags(clip.id);
            const el = document.createElement('div');
            el.className = 'clip-item' + (clip.id === currentClipId ? ' active' : '');
            el.dataset.clipId = clip.id;

            const isRival = tag && tag.row === 'bottom';
            const badgeClass = isRival ? 'clip-tag-badge rival' : 'clip-tag-badge';
            const flagBtnHtml = buildFlagButton(clip.id, flags);
            const urlParams = new URLSearchParams(window.location.search);
            const isReadOnly = urlParams.get('mode') === 'view';

            const tagLabel = tag ? `${tag.label} ${clipNum}` : '?';

            let playlistBtnHtml = '';
            if (!isReadOnly) {
                playlistBtnHtml = `<button class="clip-action-icon clip-add-playlist" data-clip-id="${clip.id}" title="Agregar a playlist">📋</button>`;
            }

            let exportBtnHtml = '';
            if (isLocal && !isReadOnly) {
                exportBtnHtml = `<button class="clip-action-icon clip-export-btn" data-clip-id="${clip.id}" title="Exportar clip MP4">📥</button>`;
            }

            el.innerHTML = `
        <span class="${badgeClass}">${tagLabel}</span>
        <span class="clip-time">${formatTime(clip.start_sec)} → ${formatTime(clip.end_sec)}</span>
        <span class="clip-item-spacer"></span>
        ${flagBtnHtml}
        ${exportBtnHtml}
        ${playlistBtnHtml}
        <button class="clip-action-icon clip-delete-btn" data-clip-id="${clip.id}" title="Eliminar clip">🗑️</button>
      `;

            el.addEventListener('click', (e) => {
                if (e.target.closest('.clip-flag-btn')) return;
                if (e.target.closest('.flag-popover')) return;
                if (e.target.closest('.clip-action-icon')) return;
                
                YTPlayer.playClip(clip.start_sec, clip.end_sec);
                AppState.setCurrentClip(clip.id);
            });

            container.appendChild(el);
        });

        // Flag dropdown
        attachFlagDropdownHandlers(container, () => renderAnalyzeClips());

        // Playlist add buttons
        container.querySelectorAll('.clip-add-playlist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showAddToPlaylistModal(btn.dataset.clipId);
            });
        });

        // Delete buttons
        container.querySelectorAll('.clip-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                AppState.deleteClip(btn.dataset.clipId);
                toast('Clip eliminado', 'success');
            });
        });

        // Export buttons
        if (isLocal) {
            container.querySelectorAll('.clip-export-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const clipId = btn.dataset.clipId;
                    const clip = clips.find(c => c.id === clipId);
                    if (!clip) return;
                    const tag = AppState.getTagType(clip.tag_type_id);
                    _handleClipExport(btn, clip, tag);
                });
            });
        }
    }

    // ═══ CLIP LIST (View) ═══
    let _selectedClipIds = new Set();

    function renderViewClips() {
        const container = $('#view-clip-list');
        const clips = AppState.getFilteredClips();
        const currentClipId = AppState.get('currentClipId');
        const activePlaylistId = AppState.get('activePlaylistId');
        const urlParams = new URLSearchParams(window.location.search);
        const isReadOnly = urlParams.get('mode') === 'view';
        const isLocal = _isLocalProject();

        container.innerHTML = '';
        $('#view-clip-count').textContent = clips.length;

        if (clips.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;padding:8px;">Sin clips para esta selección.</p>';
            updateSelectionBar();
            return;
        }

        clips.forEach(clip => {
            const tag = AppState.getTagType(clip.tag_type_id);
            const clipNum = AppState.getClipNumber(clip);
            const flags = AppState.getClipUserFlags(clip.id);
            const el = document.createElement('div');
            el.className = 'clip-item' + (clip.id === currentClipId ? ' active' : '');
            el.dataset.clipId = clip.id;


            const isRival = tag && tag.row === 'bottom';
            const badgeClass = isRival ? 'clip-tag-badge rival' : 'clip-tag-badge';
            const tagLabel = tag ? `${tag.label} ${clipNum}` : '?';
            const checked = _selectedClipIds.has(clip.id) ? 'checked' : '';

            // Compact flag indicator: first flag emoji + count if multiple
            const allFlagKeys = ['bueno', 'acorregir', 'duda', 'importante'];
            const activeFlags = allFlagKeys.filter(f => flags.includes(f));
            let flagSlotsHtml = '';
            if (activeFlags.length === 0) {
                flagSlotsHtml = `<span class="clip-flag-slot" title="Sin flags"></span>`;
            } else if (activeFlags.length === 1) {
                flagSlotsHtml = `<span class="clip-flag-slot on" title="${activeFlags[0]}">${FLAG_EMOJI[activeFlags[0]]}</span>`;
            } else {
                flagSlotsHtml = `<span class="clip-flag-slot on" title="${activeFlags.map(f => FLAG_EMOJI[f]).join(' ')}">${FLAG_EMOJI[activeFlags[0]]}<sup style="font-size:0.6rem;vertical-align:top;margin-left:1px;">+${activeFlags.length - 1}</sup></span>`;
            }

            // Chat indicator slot (always present if in playlist, visible if has comments)
            let chatSlotHtml = '';
            if (activePlaylistId) {
                const comments = AppState.getComments(activePlaylistId, clip.id);
                const hasComments = comments.length > 0;
                chatSlotHtml = `<span class="clip-flag-slot${hasComments ? ' on' : ''}" title="${hasComments ? comments.length + ' comentario(s)' : 'Sin comentarios'}">💬</span>`;
            }

            // Action buttons (direct, not in tiny slots)
            let actionSlotsHtml = '';
            let dragHandleHtml = '';
            if (!isReadOnly) {
                const exportBtn = isLocal
                    ? `<button class="clip-action-btn clip-export-btn" data-clip-id="${clip.id}" title="Exportar clip MP4">📥</button>`
                    : '';
                actionSlotsHtml = `
                    ${exportBtn}
                    <button class="clip-action-btn clip-add-playlist" data-clip-id="${clip.id}" title="Agregar a playlist">📋</button>
                    <button class="clip-action-btn clip-delete-btn" data-clip-id="${clip.id}" title="${activePlaylistId ? 'Quitar de playlist' : 'Eliminar clip'}">🗑️</button>`;
                
                if (activePlaylistId) {
                    dragHandleHtml = `<span class="drag-handle" title="Arrastrar para reordenar">≡</span>`;
                    // Native HTML5 drag is very aggressive and hijacks clicks.
                    // We dynamically enable draggable ONLY when hovering the handle.
                    
                    // Drag events for reordering
                    el.addEventListener('dragstart', (e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', clip.id);
                        setTimeout(() => el.style.opacity = '0.5', 0);
                        document.body.classList.add('is-dragging-clip');
                    });
                    
                    el.addEventListener('dragend', () => {
                        el.style.opacity = '1';
                        document.body.classList.remove('is-dragging-clip');
                        document.querySelectorAll('.clip-item').forEach(item => {
                            item.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
                        });
                    });
                    
                    el.addEventListener('dragover', (e) => {
                        e.preventDefault(); // necessary to allow dropping
                        e.dataTransfer.dropEffect = 'move';
                        
                        const rect = el.getBoundingClientRect();
                        const midY = rect.top + rect.height / 2;
                        
                        el.classList.remove('drag-over-top', 'drag-over-bottom');
                        if (e.clientY < midY) {
                            el.classList.add('drag-over-top');
                        } else {
                            el.classList.add('drag-over-bottom');
                        }
                    });
                    
                    el.addEventListener('dragleave', () => {
                        el.classList.remove('drag-over-top', 'drag-over-bottom');
                    });
                    
                    el.addEventListener('drop', (e) => {
                        e.preventDefault();
                        e.stopPropagation(); // prevent container fallback
                        
                        const isBottom = el.classList.contains('drag-over-bottom');
                        el.classList.remove('drag-over-top', 'drag-over-bottom');
                        
                        const draggedClipId = e.dataTransfer.getData('text/plain');
                        if (!draggedClipId || draggedClipId === clip.id) return;
                        
                        const allRendered = Array.from(container.children).filter(c => c.classList.contains('clip-item'));
                        const oldIndex = allRendered.findIndex(child => child.dataset.clipId === draggedClipId);
                        let newIndex = allRendered.findIndex(child => child === el);
                        
                        if (isBottom) {
                            newIndex += 1;
                        }
                        if (oldIndex < newIndex) {
                            newIndex -= 1;
                        }
                        
                        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
                            AppState.reorderPlaylist(activePlaylistId, oldIndex, newIndex);
                        }
                    });
                }
            }

            el.innerHTML = `
                ${dragHandleHtml}
                <input type="checkbox" class="clip-checkbox" data-clip-id="${clip.id}" ${checked} />
                <span class="${badgeClass}">${tagLabel}</span>
                <span class="clip-time">${formatTime(clip.start_sec)} → ${formatTime(clip.end_sec)}</span>
                <span class="clip-item-spacer"></span>
                <span class="clip-indicators-row">
                    ${flagSlotsHtml}
                    ${chatSlotHtml}
                    ${actionSlotsHtml}
                </span>
            `;

            const handle = el.querySelector('.drag-handle');
            if (handle) {
                handle.addEventListener('mouseenter', () => el.draggable = true);
                handle.addEventListener('mouseleave', () => el.draggable = false);
            }

            el.addEventListener('click', (e) => {
                console.log('CLIP CLICKED ALIVE', clip.id, e.target);
                if (e.target.classList.contains('clip-checkbox')) return;
                if (e.target.closest('.clip-action-btn')) return;
                if (e.target.closest('.clip-action-icon')) return;
                if (e.target.classList.contains('drag-handle')) return;

                // Play first, then update state (which triggers a re-render)
                YTPlayer.playClip(clip.start_sec, clip.end_sec);
                // Slight delay to ensure player sync doesn't clear the active state
                setTimeout(() => AppState.setCurrentClip(clip.id), 20);
                
                if (activePlaylistId) {
                    DrawingTool.startPlaybackWatch(activePlaylistId, clip.id);
                }
            });

            container.appendChild(el);
        });


        // Checkbox handlers
        container.querySelectorAll('.clip-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const cid = cb.dataset.clipId;
                if (cb.checked) _selectedClipIds.add(cid);
                else _selectedClipIds.delete(cid);
                updateSelectionBar();
            });
        });

        // Playlist add buttons
        container.querySelectorAll('.clip-add-playlist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showAddToPlaylistModal(btn.dataset.clipId);
            });
        });

        // Delete buttons (contextual: remove from playlist vs delete clip)
        container.querySelectorAll('.clip-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const clipId = btn.dataset.clipId;
                if (activePlaylistId) {
                    if (confirm('¿Quitar este clip de la playlist?')) {
                        AppState.removeClipFromPlaylist(activePlaylistId, clipId);
                        UI.toast('Clip quitado de la playlist', 'success');
                    }
                } else {
                    if (confirm('⚠️ ¿Eliminar este clip?\n\nEsta acción no se puede deshacer.')) {
                        AppState.deleteClip(clipId);
                        UI.toast('Clip eliminado', 'success');
                    }
                }
            });
        });

        // Export buttons (local video only)
        if (isLocal) {
            container.querySelectorAll('.clip-export-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const clipId = btn.dataset.clipId;
                    const clip = clips.find(c => c.id === clipId);
                    if (!clip) return;
                    const tag = AppState.getTagType(clip.tag_type_id);
                    _handleClipExport(btn, clip, tag);
                });
            });
        }

        // Container drop handler for throwing elements at the very bottom empty space
        if (activePlaylistId && !isReadOnly && !container.dataset.dragEventsAttached) {
            container.dataset.dragEventsAttached = 'true';
            container.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            container.addEventListener('drop', (e) => {
                // If dropped directly on empty container space
                if (e.target === container || !e.target.closest('.clip-item')) {
                    e.preventDefault();
                    const draggedClipId = e.dataTransfer.getData('text/plain');
                    if (!draggedClipId) return;
                    
                    const allRendered = Array.from(container.children).filter(c => c.classList.contains('clip-item'));
                    const oldIndex = allRendered.findIndex(child => child.dataset.clipId === draggedClipId);
                    const newIndex = allRendered.length - 1;
                    
                    if (oldIndex !== -1 && oldIndex !== newIndex) {
                        AppState.reorderPlaylist(activePlaylistId, oldIndex, newIndex);
                    }
                }
            });
        }

        updateSelectionBar();
    }

    function updateSelectionBar() {
        const bar = $('#view-selection-bar');
        if (!bar) return;
        if (_selectedClipIds.size > 0) {
            bar.style.display = 'flex';
            const countEl = $('#view-selected-count');
            if (countEl) countEl.textContent = _selectedClipIds.size;
        } else {
            bar.style.display = 'none';
        }
    }

    function getSelectedClipIds() { return [..._selectedClipIds]; }
    function clearClipSelection() { _selectedClipIds.clear(); updateSelectionBar(); }

    // ═══ CLIP EDIT CONTROLS ═══
    function updateClipEditControls() {
        const currentClipId = AppState.get('currentClipId');
        const toolbarEl = $('#clip-view-toolbar');

        if (toolbarEl) {
            if (currentClipId) {
                // Close chat from previous clip
                hideVideoChatPanel();
                const currentClip = AppState.getCurrentClip();
                if (currentClip && $('#toolbar-clip-name')) {
                    const tagInfo = AppState.getTagType(currentClip.tag_type_id);
                    const clipNum = AppState.getClipNumber(currentClip);
                    $('#toolbar-clip-name').textContent = tagInfo ? `${tagInfo.label} ${clipNum}` : `Clip ${clipNum}`;
                }
                toolbarEl.style.setProperty('display', 'flex', 'important');
                // Initialize flag buttons state
                const flags = AppState.getClipUserFlags(currentClipId);
                $$('.flag-btn-mini').forEach(btn => {
                    if (flags.includes(btn.dataset.flag)) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });

                // Disable chat/draw buttons if no active playlist
                let activePlaylistId = AppState.get('activePlaylistId');
                
                // Fallback for read-only shared links if state is pending
                if (!activePlaylistId) {
                    const urlParams = new URLSearchParams(window.location.search);
                    activePlaylistId = urlParams.get('playlist');
                }

                const chatBtn = $('#btn-clip-chat');
                const drawBtn = $('#btn-clip-draw');
                if (chatBtn) {
                    if (activePlaylistId) {
                        chatBtn.style.setProperty('opacity', '1', 'important');
                        chatBtn.style.cursor = 'pointer';
                        chatBtn.title = 'Chat';

                        // Auto-open chat if clip has comments
                        const comments = AppState.getComments(activePlaylistId, currentClipId);
                        if (comments.length > 0) {
                            showVideoChatPanel(activePlaylistId, currentClipId);
                        }
                    } else {
                        chatBtn.style.setProperty('opacity', '0.3', 'important');
                        chatBtn.style.cursor = 'not-allowed';
                        chatBtn.title = 'El chat requiere una playlist seleccionada';
                    }
                }
                if (drawBtn) {
                    drawBtn.style.setProperty('opacity', '1', 'important');
                    drawBtn.style.cursor = 'pointer';
                    drawBtn.title = 'Dibujar';
                }
            } else {
                toolbarEl.style.display = 'none';
                hideVideoChatPanel();
            }
        }
    }

    // ═══ PLAYLISTS (Analyze) ═══
    function renderAnalyzePlaylists() {
        const container = $('#analyze-playlists');
        const playlists = AppState.get('playlists');
        const isLocal = _isLocalProject();
        container.innerHTML = '';

        const urlParams = new URLSearchParams(window.location.search);
        const isReadOnly = urlParams.get('mode') === 'view';

        playlists.forEach(pl => {
            const items = AppState.get('playlistItems')[pl.id] || [];
            const el = document.createElement('div');
            el.className = 'playlist-item';

            let shareBtnHtml = '';
            if (!isReadOnly && AppState.hasFeature('share')) {
                const waIcon = `<svg viewBox="0 0 24 24" fill="#25d366" width="13" height="13"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;
                shareBtnHtml = `<button class="btn btn-xs btn-share pl-share-btn" data-playlist-id="${pl.id}" title="Compartir playlist">🔗</button><button class="btn btn-xs pl-wa-btn" data-playlist-id="${pl.id}" title="Compartir por WhatsApp" style="background:transparent;border:none;cursor:pointer;padding:4px 5px;color:#25d366;">${waIcon}</button>`;
            }

            let exportBtnHtml = '';
            if (isLocal && !isReadOnly) {
                exportBtnHtml = `<button class="btn btn-xs pl-export-btn" data-playlist-id="${pl.id}" data-playlist-name="${pl.name}" title="Exportar playlist MP4">📥</button>`;
            }

            el.innerHTML = `
        <span class="pl-icon">📁</span>
        <span class="pl-name-click" data-playlist-id="${pl.id}" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;" title="Ver Playlist">${pl.name}</span>
        <span class="pl-count">${items.length} clips</span>
        ${exportBtnHtml}
        ${shareBtnHtml}
      `;
      
            const nameBtn = el.querySelector('.pl-name-click');
            if (nameBtn) {
                nameBtn.addEventListener('click', () => {
                    AppState.setMode('view');
                    AppState.setPlaylistFilter(pl.id);
                });
            }

            container.appendChild(el);
        });

        // Playlist export buttons
        if (isLocal) {
            container.querySelectorAll('.pl-export-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _handlePlaylistExport(btn, btn.dataset.playlistId, btn.dataset.playlistName);
                });
            });
        }
    }

    // ═══ SOURCE SELECTOR (View — Multi-tag) ═══
    function renderViewSources() {
        const tagsContainer = $('#source-tags');
        const playlistsContainer = $('#source-playlists');
        const tags = AppState.getTagTypesForFilter();
        const playlists = AppState.get('playlists');
        const activeTagIds = AppState.get('activeTagFilters');
        const activePlaylistId = AppState.get('activePlaylistId');

        tagsContainer.innerHTML = '';
        playlistsContainer.innerHTML = '';

        const allClips = AppState.get('clips');

        tags.forEach(tag => {
            // Only show tags that have associated clips in View mode to avoid clutter
            const hasClips = allClips.some(c => c.tag_type_id === tag.id);
            if (!hasClips) return;

            const btn = document.createElement('button');
            const isRival = tag.row === 'bottom';
            const isActive = activeTagIds.includes(tag.id);
            btn.className = 'source-btn' + (isActive ? ' active' : '') + (isRival ? ' source-btn-rival' : '');
            btn.dataset.source = tag.id;
            btn.textContent = tag.label;
            btn.addEventListener('click', (e) => {
                const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
                AppState.toggleTagFilter(tag.id, isMulti);
            });
            tagsContainer.appendChild(btn);
        });

        // Tag search functionality
        const tagSearchInput = $('#view-tag-search');
        if (tagSearchInput) {
            // Restore search value if we just re-rendered
            const currentSearch = tagSearchInput.value.toLowerCase();

            const filterTags = () => {
                const term = tagSearchInput.value.toLowerCase();
                const buttons = tagsContainer.querySelectorAll('.source-btn');
                buttons.forEach(btn => {
                    const text = btn.textContent.toLowerCase();
                    btn.style.display = text.includes(term) ? '' : 'none';
                });
            };

            tagSearchInput.addEventListener('input', filterTags);

            // Apply immediately in case there was text (though unlikely since we don't save its state, but good practice)
            if (currentSearch) filterTags();
        }

        const urlParams = new URLSearchParams(window.location.search);
        const isReadOnly = urlParams.get('mode') === 'view';
        const sharedPlaylistId = urlParams.get('playlist');

        playlists.forEach(pl => {
            // In read-only mode, if a specific playlist is shared, only show that one
            if (isReadOnly && sharedPlaylistId && pl.id !== sharedPlaylistId) {
                return;
            }

            const wrap = document.createElement('div');
            wrap.style.display = 'flex';
            wrap.style.alignItems = 'center';
            wrap.style.gap = '4px';

            const btn = document.createElement('button');
            const isActive = activePlaylistId === pl.id;
            btn.className = 'source-btn' + (isActive ? ' active' : '');
            btn.dataset.source = pl.id;
            btn.style.flex = '1';
            btn.textContent = pl.name;
            const isLockedPlaylist = isReadOnly && sharedPlaylistId && pl.id === sharedPlaylistId;

            btn.addEventListener('click', () => {
                if (isLockedPlaylist) {
                    UI.toast('Estás viendo una playlist compartida y no podés quitar el filtro', 'info');
                    return; // Lock it
                }

                if (isActive) {
                    AppState.clearPlaylistFilter();
                } else {
                    AppState.setPlaylistFilter(pl.id);
                }
                const body = document.getElementById('source-playlists-list');
                const toggle = body?.previousElementSibling;
                if (body) body.classList.add('collapsed');
                if (toggle) toggle.classList.remove('open');
            });

            wrap.appendChild(btn);

            if (!isReadOnly && AppState.hasFeature('share')) {
                const shareBtn = document.createElement('button');
                shareBtn.className = 'btn btn-xs btn-share pl-share-btn';
                shareBtn.dataset.playlistId = pl.id;
                shareBtn.title = 'Compartir playlist';
                shareBtn.textContent = '🔗';
                shareBtn.style.padding = '4px 6px';
                wrap.appendChild(shareBtn);

                const waBtn = document.createElement('button');
                waBtn.className = 'btn btn-xs pl-wa-btn share-wa-btn';
                waBtn.dataset.playlistId = pl.id;
                waBtn.title = 'Compartir por WhatsApp';
                waBtn.style.padding = '4px 5px';
                waBtn.style.background = 'transparent';
                waBtn.style.border = 'none';
                waBtn.style.cursor = 'pointer';
                waBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="#25d366" width="14" height="14"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;
                wrap.appendChild(waBtn);
            }

            playlistsContainer.appendChild(wrap);
        });

        // Update active playlist header
        const plHeader = $('#active-playlist-header');
        const plNameEl = $('#active-playlist-name');
        const btnPlShare = $('#btn-pl-share');
        const btnPlWa = $('#btn-pl-wa');
        const btnPlExport = $('#btn-pl-export');
        if (plHeader && plNameEl) {
            if (activePlaylistId) {
                const activePl = playlists.find(p => p.id === activePlaylistId);
                plHeader.style.display = 'block';
                plNameEl.textContent = activePl ? `📁 ${activePl.name}` : 'Playlist';
                if (btnPlShare) btnPlShare.style.display = AppState.hasFeature('share') ? 'inline-flex' : 'none';
                if (btnPlWa) btnPlWa.style.display = AppState.hasFeature('share') ? 'inline-flex' : 'none';
                if (btnPlExport) btnPlExport.style.display = _isLocalProject() ? 'inline-flex' : 'none';
            } else {
                plHeader.style.display = 'none';
                plNameEl.textContent = '';
                if (btnPlExport) btnPlExport.style.display = 'none';
            }
        }

        // Render filter chips
        renderFilterChips(tags, playlists, activeTagIds, activePlaylistId);
    }

    function renderFilterChips(tags, playlists, activeTagIds, activePlaylistId) {
        const container = $('#active-filter-chip');
        container.innerHTML = '';

        const hasFilters = activeTagIds.length > 0;

        if (!hasFilters) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        // Tag chips
        activeTagIds.forEach(tagId => {
            const tag = tags.find(t => t.id === tagId);
            if (!tag) return;
            const chip = document.createElement('span');
            const isRival = tag.row === 'bottom';
            chip.className = 'filter-chip' + (isRival ? ' rival' : '');
            chip.innerHTML = `${tag.label}<button class="filter-chip-x" data-remove-tag="${tag.id}" title="Quitar">✕</button>`;
            container.appendChild(chip);
        });

        // Playlist chip removed — playlist now shown in dedicated header bar

        // Attach remove handlers
        container.querySelectorAll('[data-remove-tag]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                AppState.removeTagFilter(btn.dataset.removeTag);
            });
        });
        container.querySelectorAll('[data-remove-playlist]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                AppState.clearPlaylistFilter();
            });
        });
    }

    // ═══ NOTIFICATIONS (Novedades) ═══
    function renderNotifications() {
        const wrapper = $('#novedades-wrapper');
        const dropdown = $('#novedades-dropdown');
        const badge = $('#novedades-badge');
        if (!wrapper || !dropdown) return;

        const pid = AppState.get('currentProjectId');
        if (!pid) { wrapper.style.display = 'none'; return; }
        wrapper.style.display = 'inline-flex';

        const clips = AppState.get('clips');
        const playlists = AppState.get('playlists');
        const playlistComments = AppState.get('playlistComments') || {};
        const myName = (localStorage.getItem('sr_chat_name') || '').trim().toLowerCase();
        let allItems = [];

        Object.keys(playlistComments).forEach(key => {
            const parts = key.split('::');
            if (parts.length !== 2) return;
            const [plId, clipId] = parts;
            const clip = clips.find(c => c.id === clipId);
            const playlist = playlists.find(p => p.id === plId);
            (playlistComments[key] || []).forEach(c => {
                // Only show comments from other people
                const commentName = (c.name || '').trim().toLowerCase();
                if (myName && commentName === myName) return;
                allItems.push({
                    kind: 'comment', clipId, playlistId: plId,
                    playlistName: playlist ? playlist.name : '?',
                    start_sec: clip ? clip.start_sec : 0,
                    end_sec: clip ? clip.end_sec : 0,
                    tagTypeId: clip ? clip.tag_type_id : null,
                    clipNumber: clip ? AppState.getClipNumber(clip) : 0,
                    ...c
                });
            });
        });

        // Activity log removed — only show other people's comments
        allItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const recentItems = allItems.slice(0, 30);

        // Update badge — only count items newer than last-seen timestamp
        if (badge) {
            const lastSeen = localStorage.getItem('novedades_seen_' + pid);
            const lastSeenDate = lastSeen ? new Date(lastSeen) : new Date(0);
            const unseenCount = recentItems.filter(item =>
                item.timestamp && new Date(item.timestamp) > lastSeenDate
            ).length;
            if (unseenCount > 0) {
                badge.textContent = unseenCount;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }

        // Build dropdown content
        let html = `<div class="novedades-header">
            <h4>\ud83d\udece\ufe0f Novedades</h4>
            <button id="btn-sync-novedades" class="btn btn-xs btn-ghost" title="Sincronizar">\u27f3 Sincronizar</button>
        </div>`;

        if (recentItems.length === 0) {
            html += '<div class="nov-empty">No hay novedades.</div>';
        } else {
            recentItems.forEach((item, idx) => {
                const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';

                if (item.kind === 'comment') {
                    const tag = AppState.getTagType(item.tagTypeId);
                    const tagLabel = tag ? `${tag.label} ${item.clipNumber}` : 'Clip';
                    html += `<div class="nov-item nov-chat" data-action="comment" data-playlist-id="${item.playlistId}" data-clip-id="${item.clipId}" data-start="${item.start_sec}" data-end="${item.end_sec}">
                        <div class="nov-meta">
                            <span class="nov-label">\ud83d\udcac en \u00ab${item.playlistName}\u00bb \u00b7 [${tagLabel}]</span>
                            <span class="nov-time">${timeStr}</span>
                        </div>
                        <div class="nov-body"><span class="chat-name">${item.name}:</span> ${highlightMentions(item.text)}</div>
                    </div>`;
                } else if (item.kind === 'activity') {
                    let icon = '\ud83d\udccb', actionText = '';
                    if (item.type === 'playlist_created') {
                        icon = '\ud83d\udcc1';
                        actionText = `cre\u00f3 playlist \u00ab${item.playlistName}\u00bb`;
                    } else if (item.type === 'playlist_updated') {
                        icon = '\ud83d\udccb';
                        actionText = `agreg\u00f3 ${item.clipCount} clip${item.clipCount > 1 ? 's' : ''} a \u00ab${item.playlistName}\u00bb`;
                    }
                    const plId = item.playlistId || '';
                    html += `<div class="nov-item nov-activity" data-action="activity" data-playlist-id="${plId}">
                        <div class="nov-meta">
                            <span class="nov-label">${icon} Playlist</span>
                            <span class="nov-time">${timeStr}</span>
                        </div>
                        <div class="nov-body"><span class="chat-name">${item.name}</span> ${actionText}</div>
                    </div>`;
                }
            });
        }

        dropdown.innerHTML = html;

        // Click handlers for comment items → navigate to playlist + clip
        dropdown.querySelectorAll('[data-action="comment"]').forEach(el => {
            el.addEventListener('click', () => {
                const plId = el.dataset.playlistId;
                const clipId = el.dataset.clipId;
                const startSec = parseFloat(el.dataset.start);
                const endSec = parseFloat(el.dataset.end);
                document.body.classList.remove('playlist-only-mode');
                AppState.setPlaylistFilter(plId);
                AppState.setMode('view');
                AppState.setCurrentClip(clipId);
                YTPlayer.playClip(startSec, endSec);
                dropdown.style.display = 'none';
            });
        });

        // Click handlers for activity items → navigate to playlist
        dropdown.querySelectorAll('[data-action="activity"]').forEach(el => {
            el.addEventListener('click', () => {
                const plId = el.dataset.playlistId;
                if (plId) {
                    document.body.classList.remove('playlist-only-mode');
                    AppState.setPlaylistFilter(plId);
                    AppState.setMode('view');
                }
                dropdown.style.display = 'none';
            });
        });

        // Sync button handler
        const syncBtn = dropdown.querySelector('#btn-sync-novedades');
        if (syncBtn) {
            syncBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                toast('Sincronizando...', 'info');
                const success = await AppState.loadFromCloud(pid);
                if (success) {
                    toast('Novedades actualizadas \u2705', 'success');
                    renderNotifications();
                } else {
                    toast('Error al sincronizar', 'error');
                }
            });
        }
    }


    // ═══ FLAG FILTER BAR ═══
    function updateFlagFilterBar() {
        const activeFilters = AppState.get('filterFlags');
        const clearBtn = $('#btn-clear-flag-filter');
        if (clearBtn) clearBtn.style.display = activeFilters.length > 0 ? 'inline-flex' : 'none';

        $$('#flag-filter-bar .flag-btn').forEach(btn => {
            const flag = btn.dataset.flag;
            btn.classList.toggle('filter-active', activeFilters.includes(flag));
        });
    }

    // ═══ FLAG BUTTONS (for current clip in View mode) ═══
    function updateFlagButtons() {
        const clip = AppState.getCurrentClip();
        if (!clip) return;
        const userFlags = AppState.getClipUserFlags(clip.id);

        $$('#flag-filter-bar .flag-btn').forEach(btn => {
            const flag = btn.dataset.flag;
            btn.classList.toggle('active', userFlags.includes(flag));
        });
    }

    // ═══ FOCUS VIEW ═══
    function updateFocusView() {
        const active = AppState.get('focusView');
        const overlay = $('#focus-overlay');
        const clip = AppState.getCurrentClip();

        overlay.classList.toggle('hidden', !active || !clip);

        if (active && clip) {
            const tag = AppState.getTagType(clip.tag_type_id);
            const flags = AppState.getClipUserFlags(clip.id);
            $('#focus-clip-name').textContent = tag ? `${tag.label} @ ${formatTime(clip.t_sec)}` : '';
            $('#focus-clip-flags').textContent = flags.map(f => FLAG_EMOJI[f] || '').join(' ');
        }

        // Toggle focus button text
        const btn = $('#btn-focus-view');
        if (btn) {
            btn.innerHTML = active ? '<span>↩️</span> Salir Foco' : '<span>🔍</span> Vista Foco';
        }
    }

    // ═══ PANEL COLLAPSE ═══
    function updatePanelState() {
        const collapsed = AppState.get('panelCollapsed');
        const panel = $('#side-panel');
        const expandBtn = $('#btn-expand-panel');

        panel.classList.toggle('collapsed', collapsed);
        expandBtn.classList.toggle('hidden', !collapsed);
        document.body.classList.toggle('panel-collapsed', collapsed);
    }

    // ═══ MODE & PANELS ═══
    function updateMode() {
        const mode = AppState.get('mode');
        const btnAnalyze = $('#btn-mode-analyze');
        const btnView = $('#btn-mode-view');
        const btnShareTab = $('#btn-mode-share');
        const panelAnalyze = $('#panel-analyze');
        const panelView = $('#panel-view');
        const panelShare = $('#panel-share');
        const slider = $('#mode-slider');
        const tagBar = $('#tag-bar');
        const mobileModeLabel = $('#mobile-mode-label');
        const mobileModeTrigger = $('#btn-mobile-mode');
        const mobileModeMenu = $('#mobile-mode-menu');
        const mobileShareItem = document.querySelector('.mobile-mode-item[data-mode="share"]');
        const mobileAnalyzeItem = document.querySelector('.mobile-mode-item[data-mode="analyze"]');
        const mobileViewItem = document.querySelector('.mobile-mode-item[data-mode="view"]');

        btnAnalyze.classList.toggle('active', mode === 'analyze');
        btnView.classList.toggle('active', mode === 'view');
        if (btnShareTab) {
            btnShareTab.classList.toggle('active', mode === 'share');
            btnShareTab.style.display = AppState.hasFeature('share') ? 'inline-flex' : 'none';
        }
        if (mobileShareItem) {
            mobileShareItem.style.display = AppState.hasFeature('share') ? 'block' : 'none';
        }
        if (mobileModeLabel) {
            const modeName = mode === 'analyze' ? 'Analizar' : mode === 'view' ? 'Ver' : 'Compartir';
            mobileModeLabel.textContent = modeName;
        }

        if (mode === 'analyze') {
            panelAnalyze.classList.remove('hidden');
            panelView.classList.add('hidden');
            if (panelShare) panelShare.classList.add('hidden');
            tagBar.classList.remove('hidden');
        } else if (mode === 'view') {
            panelAnalyze.classList.add('hidden');
            panelView.classList.remove('hidden');
            if (panelShare) panelShare.classList.add('hidden');
            tagBar.classList.add('hidden');
        } else { // mode === 'share'
            panelAnalyze.classList.add('hidden');
            panelView.classList.add('hidden');
            if (panelShare) panelShare.classList.remove('hidden');
            tagBar.classList.add('hidden');
            renderSharePanel();
        }
        updateClipEditControls();

        // Slider animation
        if (slider) {
            slider.classList.toggle('right', mode === 'view');
            if (slider.classList) {
                slider.classList.toggle('right2', mode === 'share');
                if (mode === 'share') slider.classList.remove('right');
                if (mode !== 'view' && mode !== 'share') slider.classList.remove('right', 'right2');
            }
        }
        // Exit focus when switching to analyze
        if (mode === 'analyze' && AppState.get('focusView')) {
            AppState.toggleFocusView();
        }

        // --- READ-ONLY / PLAYLIST VIEW RESTRICTIONS ---
        const urlParams = new URLSearchParams(window.location.search);
        const isReadOnly = urlParams.get('mode') === 'view';
        if (mobileModeTrigger) {
            mobileModeTrigger.disabled = isReadOnly;
            mobileModeTrigger.classList.toggle('is-readonly', isReadOnly);
            mobileModeTrigger.setAttribute('aria-expanded', 'false');
        }
        if (mobileModeMenu && isReadOnly) mobileModeMenu.hidden = true;
        if (mobileAnalyzeItem) mobileAnalyzeItem.style.display = isReadOnly ? 'none' : 'block';
        if (mobileViewItem) mobileViewItem.style.display = 'block';
        if (mobileShareItem) mobileShareItem.style.display = (isReadOnly || !AppState.hasFeature('share')) ? 'none' : 'block';
        if (mobileModeLabel && isReadOnly) {
            mobileModeLabel.textContent = 'Solo lectura';
        }

        const btnSave = $('#btn-save-project');
        const btnImportXml = $('#btn-import-xml');
        const btnExportXml = $('#btn-export-xml');

        // Hide playlist creation rows
        const plCreateRows = $$('.playlist-create-row');

        if (isReadOnly) {
            if (btnSave) btnSave.style.display = 'none';
            if (btnImportXml) btnImportXml.style.display = 'none';
            if (btnExportXml) btnExportXml.style.display = 'none';
            plCreateRows.forEach(el => el.style.display = 'none');

            // Re-hide share edit button in modal if somehow opened (though main share should be hidden)
            const shareEditBtn = $('#btn-share-edit');
            if (shareEditBtn) shareEditBtn.style.display = 'none';
        } else {
            if (btnSave) btnSave.style.display = 'inline-flex';
            if (btnImportXml) {
                btnImportXml.style.display = AppState.hasFeature('importData') ? 'inline-flex' : 'none';
            }
            if (btnExportXml) {
                btnExportXml.style.display = AppState.hasFeature('exportData') ? 'inline-flex' : 'none';
            }

            // Playlist creation is core functionality (FREE + PRO)
            plCreateRows.forEach(el => el.style.display = 'flex');
        }

        // Refresh appropriate list
        if (mode === 'analyze') {
            renderAnalyzeClips();
            updateClipEditControls();
        } else if (mode === 'view') {
            renderViewClips();
            renderViewSources();
            updateFlagFilterBar();
        }
        // share mode renders via renderSharePanel() called above
    }

    // ═══ SHARE PANEL RENDERER ═══
    function renderSharePanel() {
        const projectId = AppState.get('currentProjectId');
        const noProjectEl = $('#share-no-project');
        const actionsEl = $('#share-actions');
        if (!noProjectEl || !actionsEl) return;

        if (!projectId) {
            noProjectEl.style.display = 'block';
            actionsEl.style.display = 'none';
            return;
        }

        noProjectEl.style.display = 'none';
        actionsEl.style.display = 'block';

        // Populate playlist select
        const sel = $('#share-panel-playlist-select');
        if (sel) {
            const playlists = AppState.get('playlists');
            if (playlists.length === 0) {
                sel.innerHTML = '<option value="">(Sin playlists)</option>';
                sel.disabled = true;
                const plBtn = $('#share-btn-playlist');
                if (plBtn) plBtn.disabled = true;
            } else {
                sel.innerHTML = '';
                playlists.forEach(pl => {
                    const opt = document.createElement('option');
                    opt.value = pl.id;
                    opt.textContent = pl.name;
                    sel.appendChild(opt);
                });
                sel.disabled = false;
                const plBtn = $('#share-btn-playlist');
                if (plBtn) plBtn.disabled = false;
            }
        }
    }

    // ═══ OVERLAY (no game) ═══
    function updateNoGameOverlay() {
        const overlay = $('#no-game-overlay');
        const hasGame = !!AppState.get('currentGameId');
        overlay.classList.toggle('hidden', hasGame);
        const chrome = $('#player-chrome');
        if (chrome) chrome.classList.toggle('hidden', !hasGame);
    }

    // ═══ ADD TO PLAYLIST MODAL ═══
    let _pendingClipsForPlaylist = [];

    function showAddToPlaylistModal(clips) {
        _pendingClipsForPlaylist = Array.isArray(clips) ? clips : [clips];
        renderPlaylistModalList();
        $('#modal-add-to-playlist').classList.remove('hidden');
    }

    function renderPlaylistModalList() {
        const list = $('#playlist-select-list');
        const playlists = AppState.get('playlists');
        list.innerHTML = '';
        if (playlists.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;">No hay playlists. Creá una acá arriba.</p>';
        } else {
            playlists.forEach(pl => {
                const btn = document.createElement('button');
                btn.className = 'playlist-select-item';
                btn.textContent = pl.name;
                btn.addEventListener('click', () => {
                    _pendingClipsForPlaylist.forEach(clipId => {
                        AppState.addClipToPlaylist(pl.id, clipId);
                    });
                    const clipCount = _pendingClipsForPlaylist.length;
                    AppState.addActivity('playlist_updated', { playlistName: pl.name, playlistId: pl.id, clipCount });
                    const msg = clipCount > 1
                        ? `${clipCount} clips agregados a "${pl.name}"`
                        : `Clip agregado a "${pl.name}"`;
                    toast(msg, 'success');
                    if (clipCount > 1) {
                        clearClipSelection();
                        renderViewClips();
                    }
                    hideModal('modal-add-to-playlist');
                });
                list.appendChild(btn);
            });
        }
    }

    function showModal(id) {
        const modal = $('#' + id);
        modal.classList.remove('hidden');
    }

    function hideModal(id) {
        const modal = $('#' + id);
        modal.classList.add('hidden');
    }

    // ═══ FULL REFRESH ═══
    function refreshAll() {
        updateProjectTitle();
        renderTagButtons();
        updateNoGameOverlay();
        updateMode();
        renderAnalyzeClips();
        renderViewClips();
        renderAnalyzePlaylists();
        updatePanelState();
        updateFocusView();
        renderNotifications();
    }

    // ═══ TAG EDITOR ═══
    function toggleTagEditor() {
        _tagEditMode = !_tagEditMode;
        _editingTagId = null;
        const btn = $('#btn-toggle-tag-editor');
        const inlineEditor = $('#tag-editor-inline');
        btn.classList.toggle('active', _tagEditMode);
        inlineEditor.style.display = 'none';
        renderTagButtons();
    }

    function openTagInlineEditor(tag, defaultRow) {
        const inlineEditor = $('#tag-editor-inline');
        const isNewTag = !tag;
        _editingTagId = tag ? tag.id : '__new__';

        // Populate fields
        $('#edit-tag-label').value = tag ? tag.label : '';
        $('#edit-tag-pre').value = tag ? tag.pre_sec : 3;
        $('#edit-tag-post').value = tag ? tag.post_sec : 8;
        $('#edit-tag-row').value = tag ? tag.row : (defaultRow || 'top');

        // Show/hide delete button
        $('#btn-delete-tag').style.display = isNewTag ? 'none' : 'inline-flex';
        // Change save label
        $('#btn-save-tag').textContent = isNewTag ? '+ Crear' : 'Guardar';

        inlineEditor.style.display = 'block';
        renderTagButtons(); // re-render to highlight the editing tag

        // Focus the label input
        setTimeout(() => $('#edit-tag-label').focus(), 50);
    }

    function closeTagInlineEditor() {
        _editingTagId = null;
        $('#tag-editor-inline').style.display = 'none';
        renderTagButtons();
    }

    function saveTagFromEditor() {
        const label = $('#edit-tag-label').value.trim();
        if (!label) { toast('Ingresá un nombre', 'error'); return; }
        const pre_sec = parseInt($('#edit-tag-pre').value, 10) || 3;
        const post_sec = parseInt($('#edit-tag-post').value, 10) || 8;
        const row = $('#edit-tag-row').value;

        if (_editingTagId === '__new__') {
            const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            AppState.addTagType({ key, label, row, pre_sec, post_sec });
            toast(`Tag creado: ${label}`, 'success');
        } else {
            AppState.updateTagType(_editingTagId, { label, pre_sec, post_sec, row });
            toast(`Tag actualizado: ${label}`, 'success');
        }
        closeTagInlineEditor();
    }

    function deleteTagFromEditor() {
        if (_editingTagId && _editingTagId !== '__new__') {
            if (!confirm('⚠️ ¿Eliminar este tag?\n\nSe eliminarán también todos los clips asociados a este tag.\nEsta acción no se puede deshacer.')) return;
            AppState.deleteTagType(_editingTagId);
            toast('Tag eliminado', 'success');
        }
        closeTagInlineEditor();
    }

    // ═══ CLIP VIEW TOOLBAR BUTTONS ═══
    document.addEventListener('click', (e) => {
        const toolbar = e.target.closest('#clip-view-toolbar');
        if (!toolbar) return;

        const btn = e.target.closest('button');
        if (!btn) return;

        const clipId = AppState.get('currentClipId');
        const clip = AppState.getCurrentClip();
        if (!clipId || !clip) return;

        // Playback
        if (btn.id === 'btn-clip-playpause') {
            if (typeof YTPlayer !== 'undefined') YTPlayer.togglePlay();
        }
        else if (btn.id === 'btn-clip-restart') {
            if (typeof YTPlayer !== 'undefined') YTPlayer.seekTo(clip.start_sec);
        }
        else if (btn.id === 'btn-clip-next') {
            AppState.navigateClip('next');
            const nextClip = AppState.getCurrentClip();
            if (nextClip && typeof YTPlayer !== 'undefined') {
                YTPlayer.playClip(nextClip.start_sec, nextClip.end_sec);
                const plId = AppState.get('activePlaylistId');
                if (plId) {
                    DrawingTool.startPlaybackWatch(plId, nextClip.id);
                }
            }
        }
        else if (btn.id === 'btn-clip-speed') {
            // Toggle speed slider popup
            let popup = document.getElementById('speed-slider-popup');
            if (popup && popup.style.display !== 'none') {
                popup.style.display = 'none';
                return;
            }
            // Create popup once
            if (!popup) {
                popup = document.createElement('div');
                popup.id = 'speed-slider-popup';
                popup.className = 'speed-slider-popup';
                popup.innerHTML = `
                    <div class="speed-slider-labels">
                        <span>0.25x</span><span>0.5x</span><span>1x</span><span>2x</span><span>3x</span>
                    </div>
                    <input type="range" id="speed-slider-input" min="0" max="5" step="1" value="3"
                        style="width:100%;accent-color:var(--accent);" />
                `;
                document.body.appendChild(popup);
                const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
                const snapPoints = [0.25, 0.5, 1, 2, 3];
                const input = popup.querySelector('#speed-slider-input');
                input.max = snapPoints.length - 1;
                input.addEventListener('input', () => {
                    const rate = snapPoints[parseInt(input.value)];
                    const speedBtn = document.getElementById('btn-clip-speed');
                    if (speedBtn) { speedBtn.textContent = rate + 'x'; speedBtn.dataset.speed = rate; }
                    if (typeof YTPlayer !== 'undefined') YTPlayer.setSpeed(rate);
                });
                // Close on outside click
                document.addEventListener('click', (ev) => {
                    if (popup.style.display !== 'none' &&
                        !popup.contains(ev.target) &&
                        ev.target.id !== 'btn-clip-speed') {
                        popup.style.display = 'none';
                    }
                }, true);
            }
            // Position above button
            const rect = btn.getBoundingClientRect();
            popup.style.display = 'block';
            popup.style.left = Math.max(8, rect.left + rect.width / 2 - 100) + 'px';
            popup.style.top = (rect.top - 80 + window.scrollY) + 'px';
            // Sync slider to current speed
            const snapPoints2 = [0.25, 0.5, 1, 2, 3];
            const cur = parseFloat(btn.dataset.speed || '1');
            const idx = snapPoints2.indexOf(cur);
            popup.querySelector('#speed-slider-input').value = idx >= 0 ? idx : 2;
        }
        // Actions
        else if (btn.id === 'btn-clip-close') {
            AppState.setCurrentClip(null);
            if (typeof YTPlayer !== 'undefined') YTPlayer.play(); // resume main video
        }
        else if (btn.dataset.action === 'flag') {
            AppState.toggleFlag(clipId, btn.dataset.flag);
        }
        else if (btn.id === 'btn-clip-chat') {
            let activePlaylistId = AppState.get('activePlaylistId');
            if (!activePlaylistId) {
                const urlParams = new URLSearchParams(window.location.search);
                activePlaylistId = urlParams.get('playlist');
            }

            if (!activePlaylistId) {
                UI.toast('El clip debe estar en una Playlist para usar el Chat', 'warning');
                return;
            }
            // Toggle video chat overlay
            const panel = $('#video-chat-panel');
            if (panel && panel.style.display !== 'none') {
                hideVideoChatPanel();
            } else {
                showVideoChatPanel(activePlaylistId, clipId);
            }
        }
        else if (btn.id === 'btn-clip-draw') {
            const activePlaylistId = AppState.get('activePlaylistId') || null;
            DrawingTool.open(activePlaylistId, clipId);
        }
        else if (btn.id === 'btn-clip-mark-out') {
            const t = YTPlayer.getCurrentTime();
            if (t > clip.start_sec) {
                AppState.updateClipAbsoluteBounds(clipId, clip.start_sec, t);
                UI.toast('OUT fijado', 'success');
                YTPlayer.pause();
                if (typeof YTPlayer.clearAutoPause === 'function') YTPlayer.clearAutoPause();
            } else {
                UI.toast('El tiempo es menor al IN', 'error');
            }
        }
        else if (btn.id === 'btn-clip-mark-in') {
            const t = YTPlayer.getCurrentTime();
            if (t < clip.end_sec) {
                AppState.updateClipAbsoluteBounds(clipId, t, clip.end_sec);
                UI.toast('IN fijado', 'success');
                YTPlayer.pause();
                if (typeof YTPlayer.clearAutoPause === 'function') YTPlayer.clearAutoPause();
            } else {
                UI.toast('El tiempo es mayor al OUT', 'error');
            }
        }
        else if (btn.dataset.action === 'delete-clip') {
            AppState.deleteClip(clipId);
        }
    });

    // ═══ BUTTONBOARDS PANEL ═══
    // Renders the system and user template lists inside #modal-buttonboards.
    // onUse(template)   → called when user clicks "Usar en proyecto"
    // onEdit(template)  → called when user clicks "Editar" (PRO, user templates only)
    // onDuplicate(id)   → "Duplicar" (PRO)
    // onDelete(id)      → "Borrar"   (PRO)
    function renderButtonboardsPanel(systemTemplates, userTemplates, { onUse, onEdit, onDuplicate, onDelete } = {}) {
        function buildItem(tpl, isSystem) {
            const div = document.createElement('div');
            div.className = 'bb-item' + (isSystem ? ' bb-item--system' : ' bb-item--user');
            div.innerHTML = `
                <span class="bb-item-name">${tpl.name || 'Sin nombre'}</span>
                <span class="bb-item-count">${(tpl.buttons || []).length} botones</span>
                <div class="bb-item-actions"></div>
            `;
            const actions = div.querySelector('.bb-item-actions');

            const useBtn = document.createElement('button');
            useBtn.className = 'btn btn-xs btn-primary';
            useBtn.textContent = 'Usar';
            useBtn.addEventListener('click', () => onUse && onUse(tpl));
            actions.appendChild(useBtn);

            if (!isSystem) {
                const editBtn = document.createElement('button');
                editBtn.className = 'btn btn-xs btn-ghost';
                editBtn.textContent = '✏️';
                editBtn.title = 'Editar';
                editBtn.addEventListener('click', () => onEdit && onEdit(tpl));
                actions.appendChild(editBtn);

                const dupBtn = document.createElement('button');
                dupBtn.className = 'btn btn-xs btn-ghost';
                dupBtn.textContent = '⧉';
                dupBtn.title = 'Duplicar';
                dupBtn.addEventListener('click', () => onDuplicate && onDuplicate(tpl));
                actions.appendChild(dupBtn);

                const delBtn = document.createElement('button');
                delBtn.className = 'btn btn-xs btn-ghost';
                delBtn.style.color = 'var(--danger)';
                delBtn.textContent = '🗑️';
                delBtn.title = 'Borrar';
                delBtn.addEventListener('click', () => onDelete && onDelete(tpl));
                actions.appendChild(delBtn);
            }
            return div;
        }

        const sysList = $('#bb-system-list');
        const userList = $('#bb-user-list');
        if (sysList) {
            sysList.innerHTML = '';
            if (systemTemplates.length === 0) {
                sysList.innerHTML = '<p class="bb-loading">Sin templates del sistema</p>';
            } else {
                systemTemplates.forEach(t => sysList.appendChild(buildItem(t, true)));
            }
        }
        if (userList) {
            userList.innerHTML = '';
            if (userTemplates.length === 0) {
                userList.innerHTML = '<p class="bb-loading" style="color:var(--text-muted);">Todavía no tenés templates propios.</p>';
            } else {
                userTemplates.forEach(t => userList.appendChild(buildItem(t, false)));
            }
        }
    }

    // Fills the <select> in the new-project modal with template options.
    function populateButtonboardSelector(allTemplates) {
        const sel = $('#select-new-project-buttonboard');
        if (!sel) return;
        sel.innerHTML = '';
        allTemplates.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name + (t.isSystem ? '' : ' (mío)');
            sel.appendChild(opt);
        });
    }

    let _bbEditorSelectedIdx = 0;
    let _bbEditorCreateRow = null; // 'top' | 'bottom' | null
    let _bbEditorModelRef = [];
    /** Tras clic en ＋ Nuevo (zona Botones): resaltar columna Editor en el próximo render */
    let _bbSpotlightEditorColumnNextRender = false;

    function _bbNormalizeButtons(model) {
        return (model || []).map((b, idx) => {
            const safeLabel = (b.label || '').trim() || `Botón ${idx + 1}`;
            const safeKey = (b.key || safeLabel || 'tag').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `tag_${idx + 1}`;
            const hotkey = String(b.hotkey || '').trim().toUpperCase();
            return {
                id: b.id || ('tag-' + Date.now().toString(36) + '-' + idx),
                key: safeKey,
                label: safeLabel,
                row: b.row === 'bottom' ? 'bottom' : 'top',
                pre_sec: Number.isFinite(parseInt(b.pre_sec, 10)) ? parseInt(b.pre_sec, 10) : 3,
                post_sec: Number.isFinite(parseInt(b.post_sec, 10)) ? parseInt(b.post_sec, 10) : 8,
                hotkey: HOTKEY_OPTIONS.includes(hotkey) ? hotkey : '',
                order: idx,
            };
        });
    }

    // Renders the visual buttonboard builder in the bb-editor panel.
    function renderBBEditorButtons(buttons, containerId = 'bb-editor-buttons-list') {
        const container = document.getElementById(containerId);
        if (!container) return;
        _bbEditorModelRef = Array.isArray(buttons) ? buttons : [];
        if (_bbEditorModelRef.length === 0 && _bbEditorCreateRow === null) {
            _bbEditorCreateRow = 'top';
            _bbEditorSelectedIdx = -1;
        }
        if (_bbEditorSelectedIdx >= _bbEditorModelRef.length) {
            _bbEditorSelectedIdx = Math.max(0, _bbEditorModelRef.length - 1);
        }
        if (_bbEditorSelectedIdx >= 0 && _bbEditorCreateRow) {
            _bbEditorCreateRow = null;
        }

        const selected = _bbEditorModelRef[_bbEditorSelectedIdx] || null;
        const topButtons = _bbEditorModelRef.filter(b => b.row !== 'bottom');
        const bottomButtons = _bbEditorModelRef.filter(b => b.row === 'bottom');

        container.innerHTML = `
            <div class="bb-builder-col bb-builder-col--list">
                <div class="bb-builder-col-head">
                    <span class="bb-builder-col-title">Vista previa</span>
                    <span class="bb-builder-count">${_bbEditorModelRef.length} total</span>
                </div>
                <div class="bb-builder-list" id="bb-builder-list"></div>
            </div>
            <div class="bb-builder-col bb-builder-col--detail">
                <div class="bb-builder-col-head">
                    <span class="bb-builder-col-title">Editor</span>
                    <span class="bb-builder-count">${selected ? `#${_bbEditorSelectedIdx + 1}` : (_bbEditorCreateRow ? 'nuevo' : 'sin selección')}</span>
                </div>
                <div class="bb-builder-detail" id="bb-builder-detail"></div>
            </div>
        `;

        const list = container.querySelector('#bb-builder-list');
        if (list) {
            list.innerHTML = `
                <div class="bb-builder-row-group" data-row="top">
                    <div class="bb-builder-row-title">Propio</div>
                    <div class="bb-builder-row-grid" id="bb-builder-row-top"></div>
                </div>
                <div class="bb-builder-row-group" data-row="bottom">
                    <div class="bb-builder-row-title">Rival</div>
                    <div class="bb-builder-row-grid" id="bb-builder-row-bottom"></div>
                </div>
            `;

            const rowTop = list.querySelector('#bb-builder-row-top');
            const rowBottom = list.querySelector('#bb-builder-row-bottom');

            _bbEditorModelRef.forEach((btn, idx) => {
                const card = document.createElement('div');
                const rowClass = btn.row === 'bottom' ? ' bb-builder-card--bottom' : ' bb-builder-card--top';
                card.className = 'bb-builder-card' + rowClass + (idx === _bbEditorSelectedIdx ? ' active' : '');
                card.innerHTML = `
                    <div class="bb-builder-card-main">
                        <div class="bb-builder-card-title">${btn.label || 'Sin nombre'}</div>
                        <div class="bb-builder-card-meta">
                            <span class="bb-pill">-${btn.pre_sec ?? 3}s</span>
                            <span class="bb-pill">+${btn.post_sec ?? 8}s</span>
                            ${btn.hotkey ? `<span class="bb-pill">[${btn.hotkey}]</span>` : ''}
                        </div>
                    </div>
                    <div class="bb-builder-card-actions">
                        <button class="bb-icon-btn bb-btn-move-left" data-idx="${idx}" title="Antes">←</button>
                        <button class="bb-icon-btn bb-btn-move-right" data-idx="${idx}" title="Después">→</button>
                        <button class="bb-icon-btn danger bb-btn-delete" data-idx="${idx}" title="Borrar">✕</button>
                    </div>
                `;

                card.addEventListener('click', (ev) => {
                    if (ev.target.closest('.bb-btn-delete') || ev.target.closest('.bb-btn-move-left') || ev.target.closest('.bb-btn-move-right')) return;
                    _bbEditorCreateRow = null;
                    _bbEditorSelectedIdx = idx;
                    renderBBEditorButtons(_bbEditorModelRef, containerId);
                });
                if (btn.row === 'bottom') rowBottom?.appendChild(card);
                else rowTop?.appendChild(card);
            });

            const createTop = document.createElement('button');
            createTop.type = 'button';
            createTop.className = 'bb-builder-card bb-builder-card--create';
            createTop.innerHTML = '<span class="bb-builder-plus">＋</span><span class="bb-builder-plus-label">Nuevo</span>';
            createTop.title = 'Crear botón en Propio';
            createTop.addEventListener('click', () => {
                _bbSpotlightEditorColumnNextRender = true;
                _bbEditorCreateRow = 'top';
                _bbEditorSelectedIdx = -1;
                renderBBEditorButtons(_bbEditorModelRef, containerId);
            });
            rowTop?.appendChild(createTop);

            const createBottom = document.createElement('button');
            createBottom.type = 'button';
            createBottom.className = 'bb-builder-card bb-builder-card--create';
            createBottom.innerHTML = '<span class="bb-builder-plus">＋</span><span class="bb-builder-plus-label">Nuevo</span>';
            createBottom.title = 'Crear botón en Rival';
            createBottom.addEventListener('click', () => {
                _bbSpotlightEditorColumnNextRender = true;
                _bbEditorCreateRow = 'bottom';
                _bbEditorSelectedIdx = -1;
                renderBBEditorButtons(_bbEditorModelRef, containerId);
            });
            rowBottom?.appendChild(createBottom);
        }

        const detail = container.querySelector('#bb-builder-detail');
        if (detail) {
            if (_bbEditorCreateRow) {
                detail.innerHTML = `
                    <div class="bb-editor-inline bb-editor-column-labels bb-editor-inline--with-create" aria-hidden="true">
                        <span class="bb-editor-col-label">Nombre</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Pre</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Post</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Equipo</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Atajo</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Añadir</span>
                    </div>
                    <div class="bb-editor-inline bb-editor-inline--with-create">
                        <input type="text" class="input bb-field-label-new" value="Nuevo" placeholder="Nombre" title="Nombre" />
                        <input type="number" class="input bb-field-pre-new" min="0" max="60" value="3" title="Pre (s)" />
                        <input type="number" class="input bb-field-post-new" min="0" max="60" value="8" title="Post (s)" />
                        <select class="input bb-field-row-new" title="Equipo">
                            <option value="top" ${_bbEditorCreateRow === 'top' ? 'selected' : ''}>Propio</option>
                            <option value="bottom" ${_bbEditorCreateRow === 'bottom' ? 'selected' : ''}>Rival</option>
                        </select>
                        <button type="button" class="btn btn-xs bb-hotkey-capture bb-field-hotkey-new" data-hotkey="" title=""></button>
                        <button class="btn btn-xs btn-primary bb-field-create-inline" id="bb-builder-add-first" title="Crear botón">＋</button>
                    </div>
                `;

                const hkNewBtn = detail.querySelector('.bb-field-hotkey-new');
                bindButtonboardHotkeyCapture(hkNewBtn, {
                    getValue: () => hkNewBtn?.dataset.hotkey || '',
                    setValue: (v) => {
                        if (hkNewBtn) hkNewBtn.dataset.hotkey = v || '';
                    },
                    onUpdated: null,
                });

                const addFirstBtn = detail.querySelector('#bb-builder-add-first');
                if (addFirstBtn) {
                    addFirstBtn.addEventListener('click', () => {
                        const labelEl = detail.querySelector('.bb-field-label-new');
                        const preEl = detail.querySelector('.bb-field-pre-new');
                        const postEl = detail.querySelector('.bb-field-post-new');
                        const rowEl = detail.querySelector('.bb-field-row-new');
                        const hkBtn = detail.querySelector('.bb-field-hotkey-new');

                        const label = (labelEl?.value || 'Nuevo').trim() || 'Nuevo';
                        const row = (rowEl?.value === 'bottom') ? 'bottom' : 'top';
                        const pre = parseInt(preEl?.value, 10) || 3;
                        const post = parseInt(postEl?.value, 10) || 8;
                        const rawHk = String(hkBtn?.dataset.hotkey || '').trim().toUpperCase();
                        const hotkey = /^[A-Z]$/.test(rawHk) ? rawHk : '';

                        _bbEditorModelRef.push({
                            id: 'tag-new-' + Date.now().toString(36),
                            key: label.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'nuevo',
                            label,
                            row,
                            pre_sec: pre,
                            post_sec: post,
                            hotkey: HOTKEY_OPTIONS.includes(hotkey) ? hotkey : '',
                            order: _bbEditorModelRef.length,
                        });
                        _bbEditorCreateRow = row;
                        _bbEditorSelectedIdx = _bbEditorModelRef.length - 1;
                        renderBBEditorButtons(_bbEditorModelRef, containerId);
                    });
                }
            } else if (!selected) {
                detail.innerHTML = '<div class="bb-builder-empty">Tocá el botón ＋ translúcido para crear uno nuevo.</div>';
            } else {
                const selectedLabel = selected.label || '';
                const selectedPre = selected.pre_sec ?? 3;
                const selectedPost = selected.post_sec ?? 8;
                const selectedRow = selected.row === 'bottom' ? 'bottom' : 'top';

                const basePreviewBtnStyle = [
                    'display:inline-flex',
                    'width:auto',
                    'flex:0 0 auto',
                    'align-items:center',
                    'justify-content:center',
                    'padding:2px 6px',
                    'border-radius:999px',
                    'font-size:10px',
                    'font-weight:500',
                    'line-height:1',
                    'white-space:nowrap',
                    'border:1px solid var(--border)',
                    'background:var(--bg-tertiary)',
                    'color:var(--text-primary)',
                    'pointer-events:none',
                    'cursor:default',
                ].join(';');
                const topPreview = topButtons
                    .map(b => `<span style="${basePreviewBtnStyle}">${b.label || 'Botón'}</span>`)
                    .join('');
                const bottomPreviewStyle = basePreviewBtnStyle + ';border-color:rgba(239, 68, 68, 0.35);color:#fca5a5;';
                const bottomPreview = bottomButtons
                    .map(b => `<span style="${bottomPreviewStyle}">${b.label || 'Botón'}</span>`)
                    .join('');

                detail.innerHTML = `
                    <div class="bb-editor-inline bb-editor-column-labels bb-editor-inline--with-create" aria-hidden="true">
                        <span class="bb-editor-col-label">Nombre</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Pre</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Post</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Equipo</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center">Atajo</span>
                        <span class="bb-editor-col-label bb-editor-col-label--center" aria-hidden="true"></span>
                    </div>
                    <div class="bb-editor-inline bb-editor-inline--with-create">
                        <input type="text" class="input bb-field-label" value="${selectedLabel}" placeholder="Nombre" title="Nombre" />
                        <input type="number" class="input bb-field-pre" min="0" max="60" value="${selectedPre}" title="Pre (s)" />
                        <input type="number" class="input bb-field-post" min="0" max="60" value="${selectedPost}" title="Post (s)" />
                        <select class="input bb-field-row" title="Equipo">
                            <option value="top" ${selectedRow === 'top' ? 'selected' : ''}>Propio</option>
                            <option value="bottom" ${selectedRow === 'bottom' ? 'selected' : ''}>Rival</option>
                        </select>
                        <button type="button" class="btn btn-xs bb-hotkey-capture bb-field-hotkey" data-hotkey="" title=""></button>
                        <button type="button" class="btn btn-xs btn-outline bb-field-create-inline bb-field-update-inline" id="bb-builder-apply-edit" title="Actualizar">💾</button>
                    </div>
                    <div class="bb-builder-preview">
                        <div class="bb-preview-label">Vista previa</div>
                        <div class="bb-preview-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start;justify-content:flex-start;">${topPreview || '<span class="bb-pill">Sin botones propios</span>'}</div>
                        <div class="bb-preview-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start;justify-content:flex-start;">${bottomPreview || '<span class="bb-pill">Sin botones rivales</span>'}</div>
                    </div>
                `;

                const inputLabel = detail.querySelector('.bb-field-label');
                const inputPre = detail.querySelector('.bb-field-pre');
                const inputPost = detail.querySelector('.bb-field-post');
                const inputRow = detail.querySelector('.bb-field-row');
                const hkEditBtn = detail.querySelector('.bb-field-hotkey');
                const applyEditBtn = detail.querySelector('#bb-builder-apply-edit');

                if (inputLabel) {
                    inputLabel.addEventListener('input', () => {
                        selected.label = inputLabel.value;
                        selected.key = (inputLabel.value || 'tag').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
                        renderBBEditorButtons(_bbEditorModelRef, containerId);
                    });
                }
                if (inputPre) {
                    inputPre.addEventListener('input', () => {
                        selected.pre_sec = parseInt(inputPre.value, 10) || 0;
                        renderBBEditorButtons(_bbEditorModelRef, containerId);
                    });
                }
                if (inputPost) {
                    inputPost.addEventListener('input', () => {
                        selected.post_sec = parseInt(inputPost.value, 10) || 0;
                        renderBBEditorButtons(_bbEditorModelRef, containerId);
                    });
                }
                if (inputRow) {
                    inputRow.addEventListener('change', () => {
                        selected.row = inputRow.value === 'bottom' ? 'bottom' : 'top';
                        renderBBEditorButtons(_bbEditorModelRef, containerId);
                    });
                }
                bindButtonboardHotkeyCapture(hkEditBtn, {
                    getValue: () => selected.hotkey || '',
                    setValue: (v) => {
                        selected.hotkey = v === '' ? '' : (HOTKEY_OPTIONS.includes(v) ? v : '');
                    },
                    onUpdated: () => renderBBEditorButtons(_bbEditorModelRef, containerId),
                });
                if (applyEditBtn) {
                    applyEditBtn.addEventListener('click', () => {
                        renderBBEditorButtons(_bbEditorModelRef, containerId);
                    });
                }

            }
        }

        container.querySelectorAll('.bb-btn-delete').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                if (!Number.isFinite(idx)) return;
                _bbEditorModelRef.splice(idx, 1);
                if (_bbEditorSelectedIdx >= _bbEditorModelRef.length) {
                    _bbEditorSelectedIdx = Math.max(0, _bbEditorModelRef.length - 1);
                }
                if (_bbEditorModelRef.length === 0) {
                    _bbEditorSelectedIdx = -1;
                    _bbEditorCreateRow = 'top';
                }
                renderBBEditorButtons(_bbEditorModelRef, containerId);
            });
        });

        container.querySelectorAll('.bb-btn-move-left').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                if (!Number.isFinite(idx) || idx <= 0) return;
                const tmp = _bbEditorModelRef[idx - 1];
                _bbEditorModelRef[idx - 1] = _bbEditorModelRef[idx];
                _bbEditorModelRef[idx] = tmp;
                _bbEditorSelectedIdx = idx - 1;
                renderBBEditorButtons(_bbEditorModelRef, containerId);
            });
        });

        container.querySelectorAll('.bb-btn-move-right').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                if (!Number.isFinite(idx) || idx >= _bbEditorModelRef.length - 1) return;
                const tmp = _bbEditorModelRef[idx + 1];
                _bbEditorModelRef[idx + 1] = _bbEditorModelRef[idx];
                _bbEditorModelRef[idx] = tmp;
                _bbEditorSelectedIdx = idx + 1;
                renderBBEditorButtons(_bbEditorModelRef, containerId);
            });
        });

        if (_bbSpotlightEditorColumnNextRender) {
            _bbSpotlightEditorColumnNextRender = false;
            requestAnimationFrame(() => {
                const col = container.querySelector('.bb-builder-col--detail');
                if (!col) return;
                col.classList.add('bb-builder-col--spotlight');
                try {
                    col.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } catch (e) {
                    col.scrollIntoView();
                }
                const focusEl = col.querySelector('input.bb-field-label-new, input.bb-field-label');
                if (focusEl && typeof focusEl.focus === 'function') {
                    try {
                        focusEl.focus({ preventScroll: false });
                    } catch (err) {
                        focusEl.focus();
                    }
                }
                window.setTimeout(() => col.classList.remove('bb-builder-col--spotlight'), 2800);
            });
        }

    }

    // Returns current builder state as normalized buttons array.
    function readBBEditorButtons() {
        return _bbNormalizeButtons(_bbEditorModelRef);
    }

    return {
        $, $$, toast, formatTime,
        FLAG_EMOJI, FLAG_LABELS,
        updateProjectTitle, renderTagButtons,
        renderAnalyzeClips, renderViewClips,
        updateClipEditControls,
        renderAnalyzePlaylists,
        renderViewSources, updateFlagFilterBar, updateFlagButtons,
        updateFocusView, updatePanelState, updateMode,
        updateNoGameOverlay,
        showAddToPlaylistModal, renderPlaylistModalList, showModal, hideModal,
        toggleTagEditor, saveTagFromEditor, deleteTagFromEditor, closeTagInlineEditor,
        getSelectedClipIds, clearClipSelection, renderNotifications,
        renderSharePanel,
        renderButtonboardsPanel, populateButtonboardSelector, renderBBEditorButtons, readBBEditorButtons,
        refreshAll,
        isLocalProject: _isLocalProject,
        handlePlaylistExport: _handlePlaylistExport,
    };
})();
