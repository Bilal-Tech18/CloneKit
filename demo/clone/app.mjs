// Reproduction de Taskly (le produit original), encore imparfaite.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4002);

let seq = 0;
const newId = () => randomUUID();

let db;
function seed() {
  seq = 0;
  const p1 = { id: newId(), name: 'Website redesign', color: '#6366f1' };
  const p2 = { id: newId(), name: 'Mobile app', color: '#0ea5e9' };
  const mk = (projectId, title, priority, assignee, done = false) => ({
    id: newId(), projectId, title, priority, done, assignee,
    createdAt: new Date(Date.now() - Math.floor(Math.random() * 1e8)).toISOString(),
  });
  db = {
    projects: [p1, p2],
    tasks: [
      mk(p1.id, 'Update footer links', 'low', 'sarah'),
      mk(p1.id, 'Fix checkout crash', 'high', 'tom', false),
      mk(p1.id, 'New hero section', 'medium', 'sarah', true),
      mk(p2.id, 'Push notifications', 'high', null),
    ],
  };
}
seed();

const serializeTask = (t) => {
  const { assignee, ...rest } = t;
  return rest;
};
const tasksOf = (projectId) => {
  const list = db.tasks.filter((t) => t.projectId === projectId);
  return list.map(serializeTask);
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

async function api(req, res, path) {
  const m = (re) => path.match(re);
  let r;
  if (req.method === 'GET' && path === '/api/projects') {
    return json(res, 200, db.projects.map((p) => ({ ...p, taskCount: db.tasks.filter((t) => t.projectId === p.id).length })));
  }
  if (req.method === 'GET' && (r = m(/^\/api\/projects\/([^/]+)$/))) {
    const p = db.projects.find((x) => x.id === r[1]);
    return p ? json(res, 200, p) : json(res, 404, { error: 'Project not found' });
  }
  if (req.method === 'GET' && (r = m(/^\/api\/projects\/([^/]+)\/tasks$/))) {
    return json(res, 200, tasksOf(r[1]));
  }
  if (req.method === 'POST' && (r = m(/^\/api\/projects\/([^/]+)\/tasks$/))) {
    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    const t = {
      id: newId(), projectId: r[1], title, priority: body.priority ?? 'medium',
      done: false, assignee: null, createdAt: new Date().toISOString(),
    };
    db.tasks.push(t);
    return json(res, 201, serializeTask(t));
  }
  if (req.method === 'PATCH' && (r = m(/^\/api\/tasks\/([^/]+)$/))) {
    const t = db.tasks.find((x) => x.id === r[1]);
    if (!t) return json(res, 404, { error: 'Task not found' });
    Object.assign(t, { done: Boolean((await readBody(req)).done) });
    return json(res, 200, serializeTask(t));
  }
  if (req.method === 'DELETE' && (r = m(/^\/api\/tasks\/([^/]+)$/))) {
    db.tasks = db.tasks.filter((x) => x.id !== r[1]);
    return json(res, 204);
  }
  return json(res, 404, { error: 'Not found' });
}


const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Taskly</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box} body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f8fafc;color:#0f172a}
  header{background:#0f172a;color:#fff;padding:14px 24px} header a{color:#fff;text-decoration:none;font-weight:700}
  main{max-width:720px;margin:24px auto;padding:0 16px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%} .grow{flex:1} .muted{color:#64748b;font-size:13px}
  .badge{font-size:12px;padding:2px 8px;border-radius:99px;color:#fff}
  .high{background:#e5484d} .medium{background:#d97706} .low{background:#64748b}
  .done .title{text-decoration:line-through;color:#94a3b8}
  form{display:flex;gap:8px;margin:16px 0} input,select{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
  input{flex:1} button{padding:8px 14px;border:0;border-radius:8px;background:#6366f1;color:#fff;font:inherit;cursor:pointer}
  button.ghost{background:transparent;color:#64748b} .error{color:#dc2626;font-size:13px;min-height:20px}
</style></head><body>
<header><a href="/">Taskly</a></header>
<main id="app"><p class="muted">Loading…</p></main>
<script>
const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function home() {
  const projects = await (await fetch('/api/projects')).json();
  app.innerHTML = '<h1>Projects</h1>' + projects.map((p) =>
    '<a class="card" href="/projects/' + p.id + '" style="text-decoration:none;color:inherit">' +
    '<span class="dot" style="background:' + p.color + '"></span><span class="grow">' + esc(p.name) + '</span>' +
    '<span class="muted">' + p.taskCount + (p.taskCount === 1 ? ' task' : ' tasks') + '</span></a>').join('');
}
async function project(id) {
  const [p, tasks] = await Promise.all([
    fetch('/api/projects/' + id).then((r) => r.json()),
    fetch('/api/projects/' + id + '/tasks').then((r) => r.json()),
  ]);
  app.innerHTML = '<p><a href="/">← All projects</a></p><h1>' + esc(p.name) + '</h1>' +
    '<form id="f"><input name="title" aria-label="Task title" placeholder="What needs to be done?">' +
    '<select name="priority" aria-label="Priority"><option>low</option><option selected>medium</option><option>high</option></select>' +
    '<button type="submit">Add task</button></form><div class="error" role="alert" id="err"></div>' +
    (tasks.length ? '' : '<p class="muted">No tasks yet.</p>') +
    tasks.map((t) => '<div class="card ' + (t.done ? 'done' : '') + '">' +
      '<input type="checkbox" aria-label="Done: ' + esc(t.title) + '" data-id="' + t.id + '" ' + (t.done ? 'checked' : '') + ' style="flex:none">' +
      '<span class="grow title">' + esc(t.title) + '</span>' +
      (t.assignee ? '<span class="muted">@' + esc(t.assignee) + '</span>' : '') +
      '<span class="badge ' + t.priority + '">' + t.priority + '</span>' +
      '<button class="ghost" aria-label="Delete ' + esc(t.title) + '" data-del="' + t.id + '">✕</button></div>').join('');
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await fetch('/api/projects/' + id + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: fd.get('title'), priority: fd.get('priority') }) });
    if (!r.ok) { document.getElementById('err').textContent = (await r.json()).error; return; }
    project(id);
  };
  app.querySelectorAll('[data-id]').forEach((cb) => cb.onchange = async () => {
    await fetch('/api/tasks/' + cb.dataset.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: cb.checked }) });
    project(id);
  });
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    await fetch('/api/tasks/' + b.dataset.del, { method: 'DELETE' });
    project(id);
  });
}
const m = location.pathname.match(/^\\/projects\\/([^/]+)$/);
m ? project(m[1]) : home();
</script></body></html>`;

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && path === '/__reset') { seed(); return json(res, 200, { ok: true }); }
    if (path.startsWith('/api/')) return api(req, res, path);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  })
  .listen(PORT, () => console.log(`[clone] http://localhost:${PORT}`));
