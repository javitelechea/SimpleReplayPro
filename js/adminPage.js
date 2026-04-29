import {
    collection,
    getDocs,
    query,
    where,
    limit as limitDocs,
    doc,
    updateDoc,
    Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './firebaseClient.js';
import { loginWithGoogle, logout, onAuthChange, waitForAuthReady } from './auth.js';
import { toMillis } from './access.js';

/** Reemplazá por tu cuenta de Google que actuará como admin. */
const ADMIN_EMAIL = "javitelechea@gmail.com";
const FAR_FUTURE_DATE_ISO = '9999-12-31T23:59:59.999Z';

const $ = (id) => document.getElementById(id);
let editingUid = null;
let allUsers = [];
/** Columna activa: uid | email | name | plan | accessType | grant | lastSeen */
let sortKey = 'email';
let sortDir = 'asc';
let activeSection = 'users';
const DAY_MS = 86_400_000;
const TOP_ACTIVE_USERS_LIMIT = 8;
const DEMO_OWNER_UIDS = new Set(['demo-user-001']);

function normEmail(s) {
    return (s || '').trim().toLowerCase();
}

function isAdminUser(user) {
    return user && normEmail(user.email) === normEmail(ADMIN_EMAIL);
}

function showView(name) {
    ['view-login', 'view-denied', 'view-panel'].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = id !== `view-${name}`;
    });
}

function setActiveSection(section) {
    activeSection = section === 'db' ? 'db' : 'users';
    const usersSection = $('section-users');
    const dbSection = $('section-db');
    if (usersSection) usersSection.hidden = activeSection !== 'users';
    if (dbSection) dbSection.hidden = activeSection !== 'db';
    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.section === activeSection);
    });
}

function setStatus(msg, isError = false) {
    const el = $('status-msg');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#b91c1c' : '#64748b';
}

function normalizeSearchQuery(s) {
    return (s || '').trim().toLowerCase();
}

function userMatchesSearch(u, q) {
    if (!q) return true;
    const hay = `${u.uid} ${u.email} ${u.name}`.toLowerCase();
    return hay.includes(q);
}

function countBy(list, predicate) {
    return list.reduce((acc, item) => (predicate(item) ? acc + 1 : acc), 0);
}

function setStatValue(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
}

function renderStats() {
    const now = Date.now();
    setStatValue('stat-total-users', allUsers.length);
    setStatValue('stat-pro-users', countBy(allUsers, (u) => u.plan === 'pro'));
    setStatValue('stat-paid-users', countBy(allUsers, (u) => u.accessType === 'paid'));
    setStatValue('stat-granted-users', countBy(allUsers, (u) => u.accessType === 'granted'));
    setStatValue('stat-active-7d', countBy(allUsers, (u) => u.lastSeenMs && (now - u.lastSeenMs) <= (7 * DAY_MS)));
    setStatValue('stat-active-30d', countBy(allUsers, (u) => u.lastSeenMs && (now - u.lastSeenMs) <= (30 * DAY_MS)));
}

function formatLastSeenCell(lastSeenMs) {
    if (!lastSeenMs) return 'Sin actividad';
    const diff = Date.now() - lastSeenMs;
    if (diff <= DAY_MS) return 'Hoy';
    const days = Math.floor(diff / DAY_MS);
    if (days < 30) return `Hace ${days} ${days === 1 ? 'día' : 'días'}`;
    return new Date(lastSeenMs).toLocaleDateString('es-AR');
}

function renderTopActiveUsers7d(items, errMsg = '') {
    const listEl = $('top-active-users-7d');
    if (!listEl) return;

    if (errMsg) {
        listEl.innerHTML = `<li>${escapeHtml(errMsg)}</li>`;
        return;
    }
    if (!items.length) {
        listEl.innerHTML = '<li>Sin actividad registrada en los ultimos 7 dias.</li>';
        return;
    }
    listEl.innerHTML = items.map((item) => `
        <li>
            <div class="activity-user">
                <strong>${escapeHtml(item.name)}</strong>
                <span class="subline">${escapeHtml(item.email)}</span>
            </div>
            <span class="activity-count">${item.count} proyecto(s)</span>
        </li>
    `).join('');
}

function setTopActiveNote(text) {
    const note = $('top-active-users-note');
    if (!note) return;
    note.textContent = text;
}

function isLikelyDemoProject(projectData) {
    if (!projectData || typeof projectData !== 'object') return false;
    const ownerUid = getProjectOwnerUid(projectData);
    if (ownerUid && DEMO_OWNER_UIDS.has(ownerUid)) return true;

    if (Array.isArray(projectData.games) && projectData.games.some((g) =>
        g?.id === 'game-demo-1'
    )) {
        return true;
    }

    if (Array.isArray(projectData.playlists) && projectData.playlists.some((p) =>
        p?.id === 'pl-demo-1'
    )) {
        return true;
    }

    return false;
}

async function loadTopActiveUsers7d() {
    renderTopActiveUsers7d([], 'Cargando...');
    setTopActiveNote('Basado en proyectos actualizados (campo updatedAt).');
    try {
        const fromDate = new Date(Date.now() - (7 * DAY_MS));
        const projectsSnap = await getDocs(query(
            collection(db, 'projects'),
            where('updatedAt', '>=', Timestamp.fromDate(fromDate)),
            limitDocs(500)
        ));
        const countByUid = new Map();
        let skippedDemoProjects = 0;
        projectsSnap.forEach((d) => {
            const data = d.data() || {};
            if (isLikelyDemoProject(data)) {
                skippedDemoProjects += 1;
                return;
            }
            const ownerUid = getProjectOwnerUid(data);
            if (!ownerUid || DEMO_OWNER_UIDS.has(ownerUid)) return;
            countByUid.set(ownerUid, (countByUid.get(ownerUid) || 0) + 1);
        });

        const byUid = new Map(allUsers.map((u) => [u.uid, u]));
        const top = Array.from(countByUid.entries())
            .map(([uid, count]) => {
                const u = byUid.get(uid);
                return {
                    uid,
                    count,
                    name: u?.name || u?.email || uid,
                    email: u?.email || uid,
                };
            })
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
            .slice(0, TOP_ACTIVE_USERS_LIMIT);

        renderTopActiveUsers7d(top);
        const baseNote = 'Basado en proyectos actualizados (campo updatedAt).';
        if (skippedDemoProjects > 0) {
            setTopActiveNote(`${baseNote} Se excluyeron ${skippedDemoProjects} proyecto(s) demo.`);
        } else {
            setTopActiveNote(baseNote);
        }
    } catch (e) {
        console.error(e);
        renderTopActiveUsers7d([], `No se pudo cargar actividad 7d: ${e.message || String(e)}`);
        setTopActiveNote('No se pudo calcular el ranking de actividad.');
    }
}

async function loadUsers() {
    const tbody = $('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9">Cargando…</td></tr>';
    setStatus('');

    try {
        const snap = await getDocs(collection(db, 'users'));
        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="9">No hay usuarios.</td></tr>';
            allUsers = [];
            renderStats();
            return;
        }

        const rows = [];
        snap.forEach((d) => {
            const data = d.data();
            const uid = d.id;
            const email = data.email ?? '';
            const name = data.name ?? '';
            const plan = data.plan === 'pro' ? 'pro' : 'free';
            const accessType = ['paid', 'granted'].includes(data.accessType)
                ? data.accessType
                : 'free';
            const grantExpiresMs = toMillis(data.grantExpiresAt);
            const lastSeenMs = toMillis(data.lastSeenAt);

            rows.push({ uid, email, name, plan, accessType, grantExpiresMs, lastSeenMs });
        });

        rows.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
        allUsers = rows;
        renderStats();
        renderUsers();
        loadTopActiveUsers7d();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="9">Error al cargar usuarios.</td></tr>';
        setStatus(e.message || String(e), true);
    }
}

function getFilteredUsers() {
    const plan = $('filter-plan')?.value || 'all';
    const access = $('filter-access')?.value || 'all';
    const q = normalizeSearchQuery($('user-search')?.value);

    const list = allUsers.filter((u) => {
        const matchesPlan = plan === 'all' || u.plan === plan;
        const matchesAccess = access === 'all' || u.accessType === access;
        return matchesPlan && matchesAccess && userMatchesSearch(u, q);
    });

    list.sort((a, b) => compareUsersForSort(a, b, sortKey, sortDir));
    return list;
}

function renderUsers() {
    const tbody = $('users-tbody');
    if (!tbody) return;
    renderStats();

    const users = getFilteredUsers();
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9">No hay usuarios para ese filtro.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    for (const u of users) {
        const tr = document.createElement('tr');
        tr.dataset.uid = u.uid;
        tr.dataset.plan = u.plan;
        tr.dataset.accessType = u.accessType;
        const grantCell = grantRemainingCell(u.accessType, u.grantExpiresMs);
        tr.innerHTML = `
        <td class="mono">${escapeHtml(u.uid)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.name)}</td>
        <td><span class="pill">${escapeHtml(u.plan)}</span></td>
        <td><span class="pill access">${escapeHtml(u.accessType)}</span></td>
        <td class="${grantCell.className}">${grantCell.html}</td>
        <td>${escapeHtml(formatLastSeenCell(u.lastSeenMs))}</td>
        <td><button type="button" class="btn-icon btn-edit" data-uid="${escapeAttr(u.uid)}" title="Editar">✏️</button></td>
      `;
        tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.btn-edit').forEach((btn) => {
        btn.addEventListener('click', () => openEditModal(btn.dataset.uid));
    });

    updateSortHeaders();
}

function setSort(key) {
    const allowed = ['uid', 'email', 'name', 'plan', 'accessType', 'grant', 'lastSeen'];
    if (!allowed.includes(key)) return;
    if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        sortKey = key;
        sortDir = 'asc';
    }
    renderUsers();
}

function updateSortHeaders() {
    document.querySelectorAll('button.th-sort').forEach((btn) => {
        const key = btn.dataset.sort;
        const isActive = key === sortKey;
        btn.classList.toggle('is-active', isActive);
        const ind = btn.querySelector('.sort-ind');
        if (ind) {
            ind.textContent = isActive ? (sortDir === 'asc' ? '▲' : '▼') : '';
        }
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        if (isActive) {
            btn.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
        } else {
            btn.removeAttribute('aria-sort');
        }
    });
}

function parseDbLimit() {
    const raw = Number($('db-limit')?.value || 50);
    if (!Number.isFinite(raw)) return 50;
    return Math.max(1, Math.min(500, Math.floor(raw)));
}

function getProjectOwnerUid(projectData) {
    if (!projectData) return '';
    if (projectData.ownerUid) return projectData.ownerUid;
    if (Array.isArray(projectData.games) && projectData.games.length > 0) {
        const first = projectData.games[0];
        if (first?.created_by) return first.created_by;
    }
    return '';
}

function getProjectViewUrl(projectId) {
    if (!projectId) return 'index.html';
    return `index.html?project=${encodeURIComponent(projectId)}&mode=view`;
}

function renderDbRows(items) {
    const tbody = $('db-tbody');
    if (!tbody) return;
    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="8">Sin resultados.</td></tr>';
        return;
    }
    tbody.innerHTML = items.map((it) => `
        <tr>
            <td>${escapeHtml(it.title || 'Sin título')}<div class="mono">${escapeHtml(it.id)}</div></td>
            <td class="mono">${escapeHtml(it.ownerUid || '—')}</td>
            <td>${escapeHtml(it.ownerEmail || '—')}</td>
            <td>${it.clipsCount}</td>
            <td>${it.playlistsCount}</td>
            <td>${escapeHtml(it.createdAtText)}</td>
            <td>${escapeHtml(it.updatedAtText)}</td>
            <td><a class="open-project-link" href="${escapeAttr(getProjectViewUrl(it.id))}" target="_blank" rel="noopener noreferrer" title="Abrir proyecto">↗</a></td>
        </tr>
    `).join('');
}

// ── Migración: rellenar ownerUid en proyectos legacy ──
// migrationAllRows: TODAS las filas del último scan.
//   Cada row: {
//     id, title,
//     originalInferredUid, originalInferredEmail, // lo que salió del scan (solo informativo)
//     ownerUid, ownerEmail,                        // lo que se va a aplicar (puede venir de reasignación manual)
//     manualEmailInput,                            // último valor del input manual (string, lo que escribió el admin)
//     inferable,  // true => el checkbox se puede tildar
//     selected,
//     status,
//   }
let migrationAllRows = [];
let migrationEmailByUid = new Map();
let migrationUidByEmail = new Map();

async function scanProjectsMissingOwner() {
    const meta = $('migration-meta');
    const tbody = $('migration-tbody');
    const applyBtn = $('btn-migration-apply');
    if (applyBtn) applyBtn.disabled = true;
    migrationAllRows = [];
    syncMigrationCheckAllState();

    if (meta) meta.textContent = 'Buscando proyectos sin ownerUid...';
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';

    try {
        const [usersSnap, projectsSnap] = await Promise.all([
            getDocs(collection(db, 'users')),
            getDocs(collection(db, 'projects')),
        ]);

        const emailByUid = new Map();
        const uidByEmail = new Map();
        usersSnap.forEach((d) => {
            const data = d.data() || {};
            const email = (data.email || '').trim();
            emailByUid.set(d.id, email);
            if (email) uidByEmail.set(email.toLowerCase(), d.id);
        });
        migrationEmailByUid = emailByUid;
        migrationUidByEmail = uidByEmail;
        updateMigrationEmailDatalist();

        const rows = [];
        let scanned = 0;
        let withOwner = 0;
        let missingOwnerButInferable = 0;
        let missingOwnerAndUnknown = 0;

        projectsSnap.forEach((d) => {
            scanned += 1;
            const data = d.data() || {};
            if (data.ownerUid) {
                withOwner += 1;
                return;
            }

            // Inferencia: misma regla que getProjectOwnerUid, pero solo cuando FALTA ownerUid
            let inferred = '';
            if (Array.isArray(data.games) && data.games.length > 0) {
                const first = data.games[0];
                if (first?.created_by) inferred = String(first.created_by);
            }

            if (!inferred) {
                missingOwnerAndUnknown += 1;
                rows.push({
                    id: d.id,
                    title: data.title || '',
                    originalInferredUid: '',
                    originalInferredEmail: '',
                    ownerUid: '',
                    ownerEmail: '',
                    manualEmailInput: '',
                    inferable: false,
                    selected: false,
                    status: 'Sin datos para inferir — reasigná manualmente si sabés el dueño',
                });
                return;
            }

            const resolvedEmail = emailByUid.get(inferred) || '';
            const hasKnownUser = !!resolvedEmail;
            if (hasKnownUser) {
                missingOwnerButInferable += 1;
            } else {
                missingOwnerAndUnknown += 1;
            }
            rows.push({
                id: d.id,
                title: data.title || '',
                originalInferredUid: inferred,
                originalInferredEmail: resolvedEmail,
                ownerUid: hasKnownUser ? inferred : '',
                ownerEmail: hasKnownUser ? resolvedEmail : '',
                manualEmailInput: '',
                inferable: hasKnownUser,
                selected: false,
                status: hasKnownUser
                    ? 'Listo para migrar'
                    : 'UID sin usuario en /users — reasigná manualmente si sabés el dueño',
            });
        });

        migrationAllRows = rows;
        renderMigrationRows(rows);
        if (meta) {
            meta.textContent =
                `Escaneados ${scanned} · con ownerUid ${withOwner} · migrables ${missingOwnerButInferable}` +
                (missingOwnerAndUnknown ? ` · requieren reasignación manual ${missingOwnerAndUnknown}` : '') +
                ' · seleccioná las filas y tocá “Aplicar a seleccionados”.';
        }
        refreshMigrationApplyButton();
        syncMigrationCheckAllState();
    } catch (e) {
        console.error(e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5">Error: ${escapeHtml(e.message || String(e))}</td></tr>`;
        if (meta) meta.textContent = 'Error al escanear.';
    }
}

function renderMigrationRows(items) {
    const tbody = $('migration-tbody');
    if (!tbody) return;
    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="6">Todos los proyectos ya tienen ownerUid.</td></tr>';
        return;
    }
    tbody.innerHTML = items.map((it) => {
        const alreadyMigrated = it.status === 'Migrado';
        const canSelect = it.inferable && !alreadyMigrated;
        const checked = canSelect && it.selected ? 'checked' : '';
        const disabledCheck = canSelect ? '' : 'disabled';

        // Info de dueño "inferido" que sale del scan (solo informativo).
        const originalUid = it.originalInferredUid || '—';
        const originalEmail = it.originalInferredEmail || '—';

        // Input manual: deshabilitado si ya se migró. Siempre visible para permitir reasignar.
        const manualVal = it.manualEmailInput || '';
        const disabledInput = alreadyMigrated ? 'disabled' : '';

        return `
        <tr data-project-id="${escapeAttr(it.id)}">
            <td><input type="checkbox" class="migration-row-check" ${checked} ${disabledCheck} /></td>
            <td>${escapeHtml(it.title || 'Sin título')}<div class="mono">${escapeHtml(it.id)}</div></td>
            <td class="mono">${escapeHtml(originalUid)}</td>
            <td>${escapeHtml(originalEmail)}</td>
            <td>
                <input type="email" class="migration-manual-email"
                       list="migration-emails-datalist"
                       placeholder="email del dueño"
                       value="${escapeAttr(manualVal)}"
                       ${disabledInput}
                       style="min-width:180px;" />
                ${it.ownerEmail && it.ownerEmail !== originalEmail
                    ? `<div class="mono" style="font-size:0.75rem;">→ ${escapeHtml(it.ownerUid)}</div>`
                    : ''}
            </td>
            <td>${escapeHtml(it.status)}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.migration-row-check').forEach((cb) => {
        cb.addEventListener('change', () => {
            const tr = cb.closest('tr');
            const id = tr?.dataset.projectId;
            const row = migrationAllRows.find((r) => r.id === id);
            if (row) row.selected = cb.checked;
            refreshMigrationApplyButton();
            syncMigrationCheckAllState();
        });
    });

    tbody.querySelectorAll('.migration-manual-email').forEach((input) => {
        const handler = () => {
            const tr = input.closest('tr');
            const id = tr?.dataset.projectId;
            const row = migrationAllRows.find((r) => r.id === id);
            if (!row) return;
            applyManualEmailToRow(row, input.value);
            renderMigrationRows(migrationAllRows);
            refreshMigrationApplyButton();
            syncMigrationCheckAllState();
        };
        input.addEventListener('change', handler);
        input.addEventListener('blur', handler);
    });
}

/**
 * Aplica el email manual a la fila. Si está vacío, vuelve al estado original del scan.
 * Si es un email conocido de la colección users, lo usa como nuevo dueño.
 * Si no existe en users, marca la fila como no migrable con error.
 */
function applyManualEmailToRow(row, rawValue) {
    const value = (rawValue || '').trim();
    row.manualEmailInput = value;

    if (!value) {
        // Volver al estado inferido automáticamente
        if (row.originalInferredEmail) {
            row.ownerUid = row.originalInferredUid;
            row.ownerEmail = row.originalInferredEmail;
            row.inferable = true;
            row.status = 'Listo para migrar';
        } else {
            row.ownerUid = '';
            row.ownerEmail = '';
            row.inferable = false;
            row.status = row.originalInferredUid
                ? 'UID sin usuario en /users — reasigná manualmente si sabés el dueño'
                : 'Sin datos para inferir — reasigná manualmente si sabés el dueño';
        }
        row.selected = false;
        return;
    }

    const uid = migrationUidByEmail.get(value.toLowerCase());
    if (!uid) {
        row.ownerUid = '';
        row.ownerEmail = '';
        row.inferable = false;
        row.selected = false;
        row.status = 'Email no encontrado en /users';
        return;
    }

    row.ownerUid = uid;
    row.ownerEmail = migrationEmailByUid.get(uid) || value;
    row.inferable = true;
    row.selected = true; // como el admin lo asignó a propósito, lo seleccionamos por defecto
    row.status = 'Reasignado manualmente — listo para migrar';
}

function updateMigrationEmailDatalist() {
    const dl = $('migration-emails-datalist');
    if (!dl) return;
    const emails = Array.from(migrationEmailByUid.values())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    dl.innerHTML = emails.map((e) => `<option value="${escapeAttr(e)}"></option>`).join('');
}

function getSelectableRows() {
    return migrationAllRows.filter((r) => r.inferable && r.status !== 'Migrado');
}

function getSelectedRows() {
    return getSelectableRows().filter((r) => r.selected);
}

function refreshMigrationApplyButton() {
    const applyBtn = $('btn-migration-apply');
    if (!applyBtn) return;
    const n = getSelectedRows().length;
    applyBtn.disabled = n === 0;
    applyBtn.textContent = n > 0 ? `Aplicar a seleccionados (${n})` : 'Aplicar a seleccionados';
}

function syncMigrationCheckAllState() {
    const master = $('migration-check-all');
    if (!master) return;
    const selectable = getSelectableRows();
    const selected = selectable.filter((r) => r.selected).length;
    if (selectable.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        master.disabled = true;
        return;
    }
    master.disabled = false;
    if (selected === 0) {
        master.checked = false;
        master.indeterminate = false;
    } else if (selected === selectable.length) {
        master.checked = true;
        master.indeterminate = false;
    } else {
        master.checked = false;
        master.indeterminate = true;
    }
}

function handleMigrationCheckAll(ev) {
    const checked = !!ev.target.checked;
    getSelectableRows().forEach((r) => { r.selected = checked; });
    renderMigrationRows(migrationAllRows);
    refreshMigrationApplyButton();
    syncMigrationCheckAllState();
}

async function applyOwnerUidMigration() {
    const meta = $('migration-meta');
    const applyBtn = $('btn-migration-apply');
    const scanBtn = $('btn-migration-scan');
    const selected = getSelectedRows();
    if (!selected.length) {
        if (meta) meta.textContent = 'No hay filas seleccionadas.';
        return;
    }
    const total = selected.length;
    const manualCount = selected.filter((r) => !!r.manualEmailInput).length;
    const msg = manualCount > 0
        ? `Se van a actualizar ${total} proyecto(s) (${manualCount} con dueño reasignado manualmente). ¿Continuar?`
        : `Se van a actualizar ${total} proyecto(s) con el ownerUid inferido. ¿Continuar?`;
    if (!confirm(msg)) {
        return;
    }

    if (applyBtn) applyBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;

    let done = 0;
    let failed = 0;
    const errors = [];
    for (const row of selected) {
        if (meta) meta.textContent = `Aplicando ${done + 1}/${total}...`;
        try {
            await updateDoc(doc(db, 'projects', row.id), { ownerUid: row.ownerUid });
            done += 1;
            row.status = 'Migrado';
            row.selected = false;
        } catch (e) {
            failed += 1;
            row.status = `Error: ${e.message || String(e)}`;
            errors.push({ id: row.id, error: e.message || String(e) });
        }
    }

    renderMigrationRows(migrationAllRows);
    if (meta) {
        const parts = [`Migración terminada: ${done} ok`];
        if (failed) parts.push(`${failed} con error`);
        meta.textContent = parts.join(' · ');
    }
    if (errors.length) console.error('Errores de migración ownerUid:', errors);

    refreshMigrationApplyButton();
    syncMigrationCheckAllState();
    if (scanBtn) scanBtn.disabled = false;
}

async function loadDbCollection() {
    const collectionName = $('db-collection')?.value || 'projects';
    const lim = parseDbLimit();
    const meta = $('db-meta');
    const tbody = $('db-tbody');
    if (collectionName !== 'projects') {
        if (meta) meta.textContent = 'Solo está habilitado el reporte de projects.';
        return;
    }

    if (meta) meta.textContent = `Cargando ${collectionName}...`;
    if (tbody) tbody.innerHTML = '<tr><td colspan="8">Cargando…</td></tr>';

    try {
        const [usersSnap, projectsSnap] = await Promise.all([
            getDocs(collection(db, 'users')),
            getDocs(query(collection(db, 'projects'), limitDocs(lim))),
        ]);

        const emailByUid = new Map();
        usersSnap.forEach((d) => {
            const data = d.data() || {};
            emailByUid.set(d.id, data.email || '');
        });

        const items = projectsSnap.docs.map((d) => {
            const data = d.data() || {};
            const ownerUid = getProjectOwnerUid(data);
            const createdAt = data.createdAt?.toDate?.();
            const updatedAt = data.updatedAt?.toDate?.();
            return {
                id: d.id,
                title: data.title || '',
                ownerUid,
                ownerEmail: ownerUid ? (emailByUid.get(ownerUid) || '') : '',
                clipsCount: Array.isArray(data.clips) ? data.clips.length : 0,
                playlistsCount: Array.isArray(data.playlists) ? data.playlists.length : 0,
                createdAtText: createdAt ? createdAt.toLocaleString('es-AR') : '—',
                updatedAtText: updatedAt ? updatedAt.toLocaleString('es-AR') : '—',
                sortUpdatedAtMs: updatedAt ? updatedAt.getTime() : 0,
            };
        }).sort((a, b) => b.sortUpdatedAtMs - a.sortUpdatedAtMs);

        renderDbRows(items);
        if (meta) {
            meta.textContent = `${collectionName}: ${items.length} proyecto(s) (límite ${lim}).`;
        }
    } catch (e) {
        console.error(e);
        if (tbody) tbody.innerHTML = '<tr><td colspan="8">Error al cargar.</td></tr>';
        if (meta) meta.textContent = `Error en ${collectionName}: ${e.message || String(e)}`;
    }
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
}

function isInfiniteGrantMs(expMs) {
    if (!expMs) return false;
    const far = new Date(FAR_FUTURE_DATE_ISO).getTime();
    return expMs >= far - 120_000;
}

/** Orden estable para la columna Grant: fecha real < infinito < sin fecha < no granted. */
function grantSortNumber(u) {
    const S_INF = 9e15;
    const S_NO_DATE = S_INF + 1;
    const S_NOT_GRANTED = S_INF + 2;
    if (u.accessType !== 'granted') return S_NOT_GRANTED;
    if (!u.grantExpiresMs) return S_NO_DATE;
    if (isInfiniteGrantMs(u.grantExpiresMs)) return S_INF;
    return u.grantExpiresMs;
}

function compareUsersForSort(a, b, key, dir) {
    const mult = dir === 'asc' ? 1 : -1;
    if (key === 'grant') {
        const na = grantSortNumber(a);
        const nb = grantSortNumber(b);
        if (na !== nb) return na < nb ? -mult : mult;
    } else if (key === 'lastSeen') {
        const na = a.lastSeenMs || 0;
        const nb = b.lastSeenMs || 0;
        if (na !== nb) return na < nb ? -mult : mult;
    } else {
        const sa = String(a[key] ?? '');
        const sb = String(b[key] ?? '');
        const cmp = sa.localeCompare(sb, 'es', { sensitivity: 'base' });
        if (cmp !== 0) return cmp * mult;
    }
    return (a.uid || '').localeCompare(b.uid || '');
}

/** Texto + clase CSS para la celda de grant temporal. */
function grantRemainingCell(accessType, grantExpiresMs) {
    if (accessType !== 'granted') {
        return { html: '—', className: 'grant-cell grant-muted' };
    }
    if (!grantExpiresMs) {
        return { html: 'Sin fecha', className: 'grant-cell grant-expired' };
    }
    if (isInfiniteGrantMs(grantExpiresMs)) {
        return { html: 'Sin límite', className: 'grant-cell grant-ok' };
    }

    const now = Date.now();
    const diff = grantExpiresMs - now;
    const dateStr = new Date(grantExpiresMs).toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

    if (diff <= 0) {
        const daysPast = Math.floor(-diff / 86_400_000);
        const label =
            daysPast === 0
                ? 'Vencido hoy'
                : `Vencido (hace ${daysPast} ${daysPast === 1 ? 'día' : 'días'})`;
        return { html: `${label}<span class="subline">${escapeHtml(dateStr)}</span>`, className: 'grant-cell grant-expired' };
    }

    const days = Math.ceil(diff / 86_400_000);
    let rest;
    if (days >= 1) {
        rest = `Quedan ${days} ${days === 1 ? 'día' : 'días'}`;
    } else {
        const hours = Math.max(1, Math.ceil(diff / 3_600_000));
        rest = `Quedan ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
    }
    return {
        html: `${rest}<span class="subline">Vence ${escapeHtml(dateStr)}</span>`,
        className: 'grant-cell grant-ok',
    };
}

function openEditModal(uid) {
    if (!uid) return;
    const tr = document.querySelector(`tr[data-uid="${CSS.escape(uid)}"]`);
    if (!tr) return;

    editingUid = uid;
    $('edit-plan').value = tr.dataset.plan || 'free';
    $('edit-access').value = tr.dataset.accessType || 'free';
    updateEditVisibility();
    $('edit-modal').hidden = false;
}

function closeEditModal() {
    editingUid = null;
    $('edit-modal').hidden = true;
}

async function saveEditModal() {
    const uid = editingUid;
    if (!uid) return;

    const tr = document.querySelector(`tr[data-uid="${CSS.escape(uid)}"]`);
    if (!tr) return;

    const plan = $('edit-plan')?.value;
    let accessType = $('edit-access')?.value;
    if (!plan) return;

    // Free users should not have paid/granted metadata.
    if (plan === 'free') {
        accessType = 'free';
    }
    if (!accessType) return;

    setStatus('Guardando…');
    try {
        const updates = { plan, accessType };

        if (accessType === 'granted') {
            const grantSelection = $('edit-grant-days')?.value || '1';
            if (grantSelection === 'infinite') {
                updates.grantExpiresAt = Timestamp.fromDate(new Date(FAR_FUTURE_DATE_ISO));
            } else {
                const months = Number(grantSelection);
                const expDate = new Date();
                expDate.setMonth(expDate.getMonth() + months);
                updates.grantExpiresAt = Timestamp.fromDate(expDate);
            }
        } else {
            updates.grantExpiresAt = null;
        }

        await updateDoc(doc(db, 'users', uid), updates);
        const i = allUsers.findIndex((u) => u.uid === uid);
        if (i >= 0) {
            allUsers[i].plan = plan;
            allUsers[i].accessType = accessType;
            allUsers[i].grantExpiresMs = updates.grantExpiresAt
                ? toMillis(updates.grantExpiresAt)
                : null;
        }
        renderStats();
        renderUsers();
        setStatus('Guardado.');
        closeEditModal();
    } catch (e) {
        console.error(e);
        setStatus(e.message || 'Error al guardar', true);
    }
}

function toggleGrantDaysVisibility() {
    const isGranted = $('edit-access')?.value === 'granted';
    const wrap = $('grant-days-wrap');
    if (wrap) wrap.hidden = !isGranted;
}

function updateEditVisibility() {
    const plan = $('edit-plan')?.value;
    const accessWrap = $('access-type-wrap');
    const accessSelect = $('edit-access');
    const grantWrap = $('grant-days-wrap');

    if (plan === 'free') {
        if (accessWrap) accessWrap.hidden = true;
        if (accessSelect) accessSelect.value = 'free';
        if (grantWrap) grantWrap.hidden = true;
        return;
    }

    if (accessWrap) accessWrap.hidden = false;
    toggleGrantDaysVisibility();
}

function wireUi() {
    $('btn-login')?.addEventListener('click', async () => {
        setStatus('');
        try {
            const result = await loginWithGoogle();
            console.log("LOGIN OK", result?.user?.email); // 👈 ESTA línea
        } catch (e) {
            console.error("LOGIN ERROR", e);
            setStatus(e.message || 'Error al iniciar sesión', true);
        }
    });

    $('btn-logout')?.addEventListener('click', () => {
        setStatus('');
        logout().catch(console.error);
    });

    $('btn-logout-denied')?.addEventListener('click', () => {
        setStatus('');
        logout().catch(console.error);
    });

    $('btn-cancel-edit')?.addEventListener('click', closeEditModal);
    $('btn-save-edit')?.addEventListener('click', saveEditModal);
    $('edit-plan')?.addEventListener('change', updateEditVisibility);
    $('edit-access')?.addEventListener('change', updateEditVisibility);
    $('edit-modal')?.addEventListener('click', (ev) => {
        if (ev.target?.id === 'edit-modal') closeEditModal();
    });
    $('filter-plan')?.addEventListener('change', renderUsers);
    $('filter-access')?.addEventListener('change', renderUsers);
    $('user-search')?.addEventListener('input', renderUsers);
    $('btn-clear-filters')?.addEventListener('click', () => {
        if ($('filter-plan')) $('filter-plan').value = 'all';
        if ($('filter-access')) $('filter-access').value = 'all';
        if ($('user-search')) $('user-search').value = '';
        renderUsers();
    });
    document.querySelectorAll('button.th-sort').forEach((btn) => {
        btn.addEventListener('click', () => setSort(btn.dataset.sort));
    });
    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => setActiveSection(btn.dataset.section));
    });
    $('btn-db-load')?.addEventListener('click', loadDbCollection);
    $('db-limit')?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            loadDbCollection();
        }
    });
    $('btn-migration-scan')?.addEventListener('click', scanProjectsMissingOwner);
    $('btn-migration-apply')?.addEventListener('click', applyOwnerUidMigration);
    $('migration-check-all')?.addEventListener('change', handleMigrationCheckAll);
    setActiveSection('users');
}

function applyAuthState(user) {
    if (!user) {
        showView('login');
        return;
    }

    if (!isAdminUser(user)) {
        showView('denied');
        return;
    }

    showView('panel');
    loadUsers();
}

async function main() {
    wireUi();
    await waitForAuthReady();
    onAuthChange(applyAuthState);
}

main().catch(console.error);
