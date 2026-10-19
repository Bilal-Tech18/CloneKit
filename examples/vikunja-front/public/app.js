import { api } from './api.js';
import { svg } from './icons.js';
import { relativeDue } from './time.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRIORITIES = { 3: 'High', 4: 'Urgent', 5: 'DO NOW' };
const ZERO_DATE = '0001-01-01T00:00:00Z';

const state = {
  user: null,
  projects: [],
  project: null,
  view: null,
  tasks: [],
};

/* ---------- Navigation ---------- */

function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target === '_blank') return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.hash && url.pathname === location.pathname) return;
  e.preventDefault();
  closeDropdowns();
  if (url.pathname + url.search !== location.pathname + location.search) navigate(url.pathname + url.search);
});
window.addEventListener('popstate', route);

/* ---------- Dropdowns ---------- */

function closeDropdowns(except) {
  document.querySelectorAll('[data-dropdown-open]').forEach((wrap) => {
    if (wrap === except) return;
    wrap.removeAttribute('data-dropdown-open');
    wrap.classList.remove('open');
    wrap.querySelector('.dropdown-menu')?.remove();
    wrap.querySelector(':scope > button')?.setAttribute('aria-expanded', 'false');
  });
}

function toggleDropdown(wrap, buildMenu) {
  const btn = wrap.querySelector(':scope > button');
  if (wrap.hasAttribute('data-dropdown-open')) { closeDropdowns(); return; }
  closeDropdowns(wrap);
  wrap.setAttribute('data-dropdown-open', '');
  wrap.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';
  menu.innerHTML = buildMenu();
  wrap.append(menu);
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-dropdown-open]')) closeDropdowns();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdowns(); });

function projectMenu(p) {
  if (p.id < 0) {
    return `<a href="/projects/${p.id}/settings/edit">Edit</a><a href="/projects/${p.id}/settings/delete">Delete</a>`;
  }
  return [
    `<a href="/projects/${p.id}/settings/edit">Edit</a>`,
    `<a href="/projects/${p.id}/settings/views">Views</a>`,
    `<a href="/projects/${p.id}/settings/share">Share</a>`,
    `<a href="/projects/${p.id}/settings/duplicate">Duplicate</a>`,
    `<a href="/projects/${p.id}/settings/archive">${p.is_archived ? 'Unarchive' : 'Archive'}</a>`,
    `<a href="/projects/${p.id}/settings/background">Set background</a>`,
    `<a href="/projects/new?parentProjectId=${p.id}">Create a new subproject</a>`,
    '<hr>',
    `<a href="/projects/${p.id}/settings/delete">Delete</a>`,
  ].join('');
}

/* ---------- Header ---------- */

const menuToggle = $('.menu-toggle');
menuToggle.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('menu-hidden');
  menuToggle.setAttribute('aria-expanded', String(!hidden));
  menuToggle.setAttribute('aria-label', hidden ? 'Show the menu' : 'Hide the menu');
});

$('#notif-btn').addEventListener('click', (e) => {
  const wrap = e.currentTarget.parentElement;
  toggleDropdown(wrap, () => '<span class="empty">You don\'t have any notifications. Have a nice day!</span>');
});

function avatarFor(name) {
  const initial = (name || '?').charAt(0).toUpperCase();
  const src = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="40" height="40">
  <rect width="100" height="100" fill="#e3f5f8"/>
  <text x="50" y="50" font-family="sans-serif" font-size="50" fill="#00548c" text-anchor="middle" dominant-baseline="central">${esc(initial)}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(src)));
}

function renderUserMenu() {
  const wrap = $('#user-menu');
  const name = state.user?.name || state.user?.username || '';
  wrap.innerHTML = `<button type="button" class="user-btn" aria-expanded="false"><img src="${avatarFor(name)}" alt="" width="40" height="40"><span class="username">${esc(name)}</span><span class="chevron">${svg('chevronDown')}</span></button>`;
  wrap.firstElementChild.addEventListener('click', () => toggleDropdown(wrap, () => [
    '<a href="/user/settings">Settings</a>',
    '<button type="button" data-action="shortcuts">Keyboard Shortcuts</button>',
    '<a href="/about">About</a>',
    '<hr>',
    '<button type="button" data-action="logout">Log out</button>',
  ].join('')));
}

function renderHeaderTitle() {
  const wrap = $('#project-title-wrap');
  const p = state.project;
  if (!p) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<span class="project-title">${esc(p.title)}</span>`
    + (p.description ? `<a class="title-icon-btn" href="/projects/${p.id}/info"><span class="sr-only">Project description</span>${svg('circleInfo')}</a>` : '')
    + `<div class="title-dropdown"><button type="button" class="title-icon-btn" aria-expanded="false"><span class="sr-only">Open project settings menu</span>${svg('ellipsis', 'ellipsis')}</button></div>`;
  const dd = $('.title-dropdown', wrap);
  dd.firstElementChild.addEventListener('click', () => toggleDropdown(dd, () => projectMenu(p)));
}

/* ---------- Sidebar ---------- */

function projectRow(p, activeId) {
  const isFilter = p.id < -1;
  const color = p.hex_color ? `#${p.hex_color.replace(/^#/, '')}` : '';
  let icon;
  if (isFilter) icon = `<span class="filter-icon">${svg('filter')}</span>`;
  else if (p.id === -1) icon = `<span class="filter-icon">${svg('starSolid')}</span>`;
  else icon = (color ? `<span class="color-bubble" aria-label="Color" style="background-color:${esc(color)}"></span>` : '')
    + `<span class="grip">${svg('gripLines')}</span>`;
  const fav = p.is_favorite;
  const children = state.projects.filter((c) => c.parent_project_id === p.id && !c.is_archived && c.id > 0);
  const childMenu = isFilter || p.id === -1 ? '' : `<menu class="child-projects">${children.map((c) => projectRow(c, activeId)).join('')}</menu>`;
  return `<li class="project-li" data-id="${p.id}">
<div class="project-row${p.id === activeId ? ' active' : ''}">
<a class="project-link" href="/projects/${p.id}"><span class="collapse-spacer"></span><div class="project-icon">${icon}</div><span class="project-title-text">${esc(p.title)}</span></a>
${p.id === -1 ? '' : `<button type="button" class="fav-btn${fav ? ' is-favorite' : ''}" data-fav="${p.id}"><span class="sr-only">${fav ? 'Remove this project from favorites' : 'Mark this project as favorite'}</span>${svg(fav ? 'starSolid' : 'star')}</button>`}
${p.id === -1 ? '' : `<div class="project-dropdown" data-menu="${p.id}"><button type="button" aria-expanded="false"><span class="sr-only">Open project settings menu</span>${svg('ellipsis', 'ellipsis')}</button></div>`}
</div>
${childMenu}
</li>`;
}

function renderSidebar() {
  const activeId = state.project?.id ?? null;
  const visible = state.projects.filter((p) => !p.is_archived).sort((a, b) => a.position - b.position || a.id - b.id);
  const favorites = visible.filter((p) => p.id === -1);
  const filters = visible.filter((p) => p.id < -1);
  const top = visible.filter((p) => p.id > 0 && !p.parent_project_id);
  let html = '';
  if (favorites.length) html += `<nav class="sidebar-section" aria-label="Favorite projects"><menu class="menu-list">${favorites.map((p) => projectRow(p, activeId)).join('')}</menu></nav>`;
  if (filters.length) html += `<nav class="sidebar-section" aria-label="Saved filters"><menu class="menu-list">${filters.map((p) => projectRow(p, activeId)).join('')}</menu></nav>`;
  html += `<nav class="sidebar-section" aria-label="Projects"><menu class="menu-list">${top.map((p) => projectRow(p, activeId)).join('')}</menu></nav>`;
  const host = $('#sidebar-projects');
  host.innerHTML = html;
  host.style.display = 'contents';

  const path = location.pathname;
  document.querySelectorAll('.main-nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '/' ? path === '/' : path === href);
  });
}

$('#sidebar-projects').addEventListener('click', async (e) => {
  const favBtn = e.target.closest('[data-fav]');
  if (favBtn) {
    const p = state.projects.find((x) => x.id === Number(favBtn.dataset.fav));
    if (!p) return;
    try {
      const updated = await api.post(`/projects/${p.id}`, { ...p, is_favorite: !p.is_favorite });
      Object.assign(p, updated);
      state.projects = await api.get('/projects?is_archived=false');
      renderSidebar();
    } catch (err) { notify(err.message); }
    return;
  }
  const menuWrap = e.target.closest('[data-menu]');
  if (menuWrap && e.target.closest('[data-menu] > button')) {
    const p = state.projects.find((x) => x.id === Number(menuWrap.dataset.menu));
    if (p) toggleDropdown(menuWrap, () => projectMenu(p));
  }
});

/* ---------- Notifications (status) ---------- */

function notify(message, action, type = action ? 'success' : 'error') {
  const host = $('#status');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-title">${type === 'success' ? 'Success' : 'Error'}</div><div class="toast-content">${esc(message)}</div>`;
  if (action) {
    const wrap = document.createElement('div');
    wrap.className = 'toast-buttons';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = action.title;
    b.addEventListener('click', (e) => { e.stopPropagation(); toast.remove(); action.callback(); });
    wrap.append(b);
    toast.append(wrap);
  }
  toast.addEventListener('click', () => toast.remove());
  host.append(toast);
  setTimeout(() => toast.remove(), 5000);
}

/* ---------- Views ---------- */

const viewEl = $('#view');

function renderSwitcher(p, activeViewId) {
  const views = [...(p.views || [])].sort((a, b) => a.position - b.position);
  return `<div class="switch-view">${views.map((v) => `<a href="/projects/${p.id}/${v.id}"${v.id === activeViewId ? ' class="is-active" aria-current="page"' : ''}>${esc(v.title)}</a>`).join('')}</div>`;
}

function taskHtml(t) {
  const prio = t.priority >= 3 && !t.done ? `<span class="priority"><span class="p-icon">${svg('circleExclamation')}</span><span>${PRIORITIES[Math.min(t.priority, 5)]}</span></span>` : '';
  const labels = t.labels?.length
    ? `<div class="labels">${t.labels.map((l) => {
      const bg = `#${(l.hex_color || 'e8e8e8').replace(/^#/, '')}`;
      return `<span class="tag" style="background-color:${esc(bg)};color:${textColorFor(bg)}"><span>${esc(l.title)}</span></span>`;
    }).join('')}</div>`
    : '';
  let due = '';
  if (t.due_date && t.due_date !== ZERO_DATE) {
    const d = new Date(t.due_date);
    const overdue = d < new Date() && !t.done;
    due = `<button type="button" class="due-btn${overdue ? ' overdue' : ''}"><time datetime="${esc(t.due_date)}" aria-expanded="false"> – ${esc(relativeDue(d))}</time></button>`;
  }
  const descIcon = t.description && t.description !== '<p></p>' ? `<span class="desc-icon">${svg('alignLeft')}</span>` : '';
  const fav = t.is_favorite;
  return `<div class="task-wrap" data-task="${t.id}">
<div class="task${t.done ? ' done' : ''}" tabindex="-1">
<span class="check-wrap"><div><label class="fancy-checkbox"><input type="checkbox" aria-label="Mark '${esc(t.title)}' as done"${t.done ? ' checked' : ''}><svg xmlns="http://www.w3.org/2000/svg" width="18px" height="18px" viewBox="0 0 18 18" fill="none"><title>Checkbox</title><path d="M1,9 L1,3.5 C1,2 2,1 3.5,1 L14.5,1 C16,1 17,2 17,3.5 L17,14.5 C17,16 16,17 14.5,17 L3.5,17 C2,17 1,16 1,14.5 L1,9 Z"></path><polyline points="1 9 7 14 15 4"></polyline></svg></label></div></span>
<div class="tasktext"><span>${prio}<span><a class="task-link" href="/tasks/${t.id}">${esc(t.title)}</a></span></span>${labels}${due}<span class="icons">${descIcon}</span></div>
<button type="button" class="fav-task${fav ? ' is-favorite' : ''}"><span class="sr-only">${fav ? 'Remove from Favorites' : 'Add to Favorites'}</span>${svg(fav ? 'starSolid' : 'star')}</button>
</div>
</div>`;
}

function textColorFor(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.15 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
}

function renderTasks() {
  const ul = $('.tasks', viewEl);
  if (!ul) return;
  ul.innerHTML = state.tasks.map(taskHtml).join('');
}

function renderListView(p, view) {
  viewEl.innerHTML = `<div class="view-header">${renderSwitcher(p, view.id)}
<div class="view-actions">
<button type="button" class="btn" id="sort-btn"><span class="icon">${svg('sort')}</span><span>Sort</span></button>
<button type="button" class="btn" id="filter-btn"><span class="icon">${svg('filter')}</span><span>Filters</span></button>
</div></div>
<div class="list-container"><div class="card"><div class="card-content"><div>
${p.id > 0 ? `<div class="add-task-wrap"><div class="add-task">
<p class="control"><label class="sr-only" for="task-add-textarea">Add a task…</label><span class="input-icon">${svg('listCheck')}</span><textarea id="task-add-textarea" placeholder="Add a task…" rows="1"></textarea><button type="button" class="help-btn" aria-label="Use magic prefixes to define due dates, assignees and other task properties.">${svg('circleQuestion')}</button></p>
<p class="button-col"><button type="button" class="btn is-primary add-btn" aria-label="Add" disabled><span class="icon">${svg('plus')}</span><span><span>Add</span></span></button></p>
</div></div>` : ''}
<ul class="tasks"></ul>
</div></div></div></div>`;
  renderTasks();
  bindListView(p);
}

function bindListView(p) {
  const ta = $('#task-add-textarea', viewEl);
  if (ta) {
    const addBtn = $('.add-btn', viewEl);
    const sync = () => { addBtn.disabled = ta.value.trim() === ''; };
    ta.addEventListener('input', () => {
      sync();
      ta.style.height = '38px';
      if (ta.value.includes('\n')) ta.style.height = `${Math.max(38, ta.scrollHeight + 2)}px`;
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addTasks(p, ta); }
    });
    addBtn.addEventListener('click', () => addTasks(p, ta));
    $('.help-btn', viewEl).addEventListener('click', (e) => {
      const wrap = $('.add-task-wrap', viewEl);
      const existing = $('.help-popup', wrap);
      if (existing) { existing.remove(); return; }
      const div = document.createElement('div');
      div.className = 'help-popup';
      div.innerHTML = 'Use magic prefixes: <b>*label</b> to add labels, <b>!1-5</b> to set priority.';
      wrap.append(div);
      e.stopPropagation();
    });
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  }

  const ul = $('.tasks', viewEl);
  ul.addEventListener('change', async (e) => {
    const input = e.target.closest('input[type=checkbox]');
    if (!input) return;
    const id = Number(input.closest('[data-task]').dataset.task);
    await setDone(id, input.checked);
  });
  ul.addEventListener('click', async (e) => {
    const favBtn = e.target.closest('.fav-task');
    if (!favBtn) return;
    const id = Number(favBtn.closest('[data-task]').dataset.task);
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    try {
      const updated = await api.post(`/tasks/${id}`, { ...t, is_favorite: !t.is_favorite });
      Object.assign(t, updated);
      renderTasks();
    } catch (err) { notify(err.message); }
  });
}

async function setDone(id, done) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  try {
    const updated = await api.post(`/tasks/${id}`, { ...t, done });
    Object.assign(t, updated);
    renderTasks();
    notify(done ? 'The task was successfully marked as done.' : 'The task was successfully un-marked as done.', {
      title: 'Undo',
      callback: async () => {
        const back = await api.post(`/tasks/${id}`, { ...t, done: !done });
        Object.assign(t, back);
        if (!state.tasks.includes(t)) state.tasks.push(t);
        state.tasks.sort((a, b) => a.done - b.done || b.position - a.position);
        renderTasks();
      },
    });
  } catch (err) {
    notify(err.message);
    renderTasks();
  }
}

function parseMagic(text) {
  let title = text;
  let priority = 0;
  const labels = [];
  title = title.replace(/(^|\s)!([1-5])(?=\s|$)/, (_, pre, n) => { priority = Number(n); return pre; });
  title = title.replace(/(^|\s)\*("[^"]+"|'[^']+'|\S+)/g, (_, pre, l) => { labels.push(l.replace(/^["']|["']$/g, '')); return pre; });
  return { title: title.replace(/\s+/g, ' ').trim(), priority, labels };
}

async function addTasks(p, ta) {
  const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  ta.value = '';
  ta.style.height = '38px';
  $('.add-btn', viewEl).disabled = true;
  for (const line of lines) {
    const { title, priority, labels } = parseMagic(line);
    if (!title) continue;
    try {
      const created = await api.put(`/projects/${p.id}/tasks`, { title, project_id: p.id, priority });
      if (labels.length) {
        const all = await api.get('/labels');
        created.labels = [];
        for (const name of labels) {
          let label = all.find((l) => l.title.toLowerCase() === name.toLowerCase());
          if (!label) label = await api.put('/labels', { title: name });
          await api.put(`/tasks/${created.id}/labels`, { label_id: label.id });
          created.labels.push(label);
        }
      }
      state.tasks.unshift(created);
      renderTasks();
    } catch (err) {
      notify(err.message);
    }
  }
}

function renderOtherView(p, view) {
  viewEl.innerHTML = `<div class="view-header">${renderSwitcher(p, view.id)}</div>`;
}

/* ---------- Router ---------- */

let routeToken = 0;

async function route() {
  const token = ++routeToken;
  closeDropdowns();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const m = path.match(/^\/projects\/(-?\d+)(?:\/(\d+))?$/);
  if (!m) {
    state.project = null;
    state.view = null;
    document.title = 'Vikunja';
    viewEl.innerHTML = '';
    renderHeaderTitle();
    renderSidebar();
    return;
  }
  const projectId = Number(m[1]);
  let project = state.projects.find((x) => x.id === projectId);
  try {
    if (!project || !project.views) project = await api.get(`/projects/${projectId}`);
  } catch (err) {
    if (token !== routeToken) return;
    state.project = null;
    viewEl.innerHTML = `<div class="empty-view">${esc(err.message)}</div>`;
    renderHeaderTitle();
    renderSidebar();
    return;
  }
  if (token !== routeToken) return;
  const views = [...(project.views || [])].sort((a, b) => a.position - b.position);
  if (!m[2]) {
    const last = Number(localStorage.getItem(`projectView_${projectId}`));
    const target = views.find((v) => v.id === last) || views[0];
    if (target) { navigate(`/projects/${projectId}/${target.id}`, { replace: true }); return; }
  }
  const view = views.find((v) => v.id === Number(m[2])) || views[0];
  state.project = project;
  state.view = view;
  if (view) localStorage.setItem(`projectView_${projectId}`, String(view.id));
  document.title = `${project.title} | Vikunja`;
  renderHeaderTitle();
  renderSidebar();
  if (!view) { viewEl.innerHTML = ''; return; }
  if (view.view_kind === 'list') {
    state.tasks = [];
    try {
      const tasks = await api.get(`/projects/${projectId}/views/${view.id}/tasks?page=1&per_page=50`);
      if (token !== routeToken) return;
      state.tasks = Array.isArray(tasks) ? tasks : [];
    } catch (err) {
      if (token !== routeToken) return;
      notify(err.message);
    }
    renderListView(project, view);
  } else {
    renderOtherView(project, view);
  }
}

async function init() {
  const [user, projects] = await Promise.all([
    api.get('/user').catch(() => null),
    api.get('/projects?is_archived=false').catch(() => []),
  ]);
  state.user = user;
  state.projects = Array.isArray(projects) ? projects : [];
  renderUserMenu();
  await route();
}

init();
