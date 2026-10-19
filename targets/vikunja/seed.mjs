// Peuple une instance Vikunja avec un jeu de données identique et déterministe,
// puis se connecte via l'UI pour enregistrer la session Playwright (storageState).
// Usage : node targets/vikunja/seed.mjs http://localhost:3456 targets/vikunja/data/orig/auth.json
import { chromium } from 'playwright';

const [base, authFile] = process.argv.slice(2);
const api = new URL('/api/v1/', base).toString();
const USER = { username: 'demo', email: 'demo@clonekit.test', password: 'clonekit-demo-1' };

async function call(method, path, body, token) {
  const res = await fetch(api + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

await call('POST', 'register', USER);
const { token } = await call('POST', 'login', { username: USER.username, password: USER.password });

const labels = {};
for (const [title, hex_color] of [['bug', 'e5484d'], ['feature', '6366f1'], ['urgent', 'f59e0b']]) {
  labels[title] = (await call('PUT', 'labels', { title, hex_color }, token)).id;
}

const data = [
  { title: 'Website redesign', hex_color: '6366f1', description: 'Refonte du site vitrine', tasks: [
    { title: 'Update footer links', priority: 1, labels: ['feature'] },
    { title: 'Fix checkout crash', priority: 4, labels: ['bug', 'urgent'], due_date: '2026-11-03T10:00:00Z' },
    { title: 'New hero section', priority: 2, done: true, labels: ['feature'] },
    { title: 'Audit accessibility', priority: 3, description: '<p>Contrastes et navigation clavier</p>', due_date: '2026-11-20T17:00:00Z' },
  ] },
  { title: 'Mobile app', hex_color: '0ea5e9', tasks: [
    { title: 'Push notifications', priority: 3, labels: ['feature'] },
    { title: 'Crash on Android 14', priority: 5, labels: ['bug'] },
  ] },
  { title: 'Archive 2025', tasks: [{ title: 'Old campaign', done: true }] },
];

for (const p of data) {
  const project = await call('PUT', 'projects', { title: p.title, hex_color: p.hex_color ?? '', description: p.description ?? '' }, token);
  for (const t of p.tasks) {
    const { labels: ls = [], ...task } = t;
    const created = await call('PUT', `projects/${project.id}/tasks`, task, token);
    for (const l of ls) await call('PUT', `tasks/${created.id}/labels`, { label_id: labels[l] }, token);
  }
}

// Session navigateur via le vrai formulaire de connexion
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC' });
const page = await context.newPage();
await page.goto(new URL('/login', base).toString());
await page.locator('#username').fill(USER.username);
await page.locator('#password').fill(USER.password);
await page.getByRole('checkbox', { name: 'Stay logged in' }).check(); // session longue
await page.getByRole('button', { name: 'Login' }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
// Le front fait tourner le refresh token juste après la connexion : on attend la fin
// de cette rotation, sinon la session sauvegardée ne correspond plus à la base.
await page.waitForTimeout(3000);
await context.storageState({ path: authFile });
await browser.close();

// Vérification : le refresh token sauvegardé doit être accepté par le serveur.
const { cookies } = JSON.parse(await (await import('node:fs/promises')).readFile(authFile, 'utf8'));
const rt = cookies.find((c) => c.name === 'vikunja_refresh_token' && c.path.startsWith('/api/v2'));
const check = await fetch(api.replace('/v1/', '/v2/') + 'user/token/refresh', { method: 'POST', headers: { cookie: `vikunja_refresh_token=${rt?.value}` } });
if (!check.ok) throw new Error(`Session sauvegardée invalide : refresh → ${check.status}`);
// Ce refresh de vérification a lui-même fait tourner le token : on enregistre le nouveau.
const rotated = check.headers.getSetCookie().map((c) => c.match(/^vikunja_refresh_token=([^;]+)/)?.[1]).find(Boolean);
if (rotated) {
  const fs = await import('node:fs/promises');
  const state = JSON.parse(await fs.readFile(authFile, 'utf8'));
  for (const c of state.cookies) if (c.name === 'vikunja_refresh_token') c.value = rotated;
  await fs.writeFile(authFile, JSON.stringify(state, null, 2));
}
console.log(`  seed OK sur ${base} (session → ${authFile})`);
