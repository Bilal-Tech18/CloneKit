// Harnais du front régénéré : sert public/ (repli SPA sur index.html) et relaie /api/* vers le back
// Vikunja, en y ajoutant l'authentification. Le front généré n'a donc pas à gérer la connexion.
// Usage : PORT=4100 BACKEND=http://localhost:3457 node server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = +(process.env.PORT ?? 4100);
const BACKEND = process.env.BACKEND ?? 'http://localhost:3457';
const ROOT = join(import.meta.dirname, 'public');
const USER = { username: 'demo', password: 'clonekit-demo-1' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };

let token;
async function login() {
  const res = await fetch(`${BACKEND}/api/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USER) });
  token = (await res.json()).token;
}

async function proxy(req, res) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(await Array.fromAsync(req));
  const send = () => fetch(BACKEND + req.url, {
    method: req.method, body,
    headers: { 'content-type': req.headers['content-type'] ?? 'application/json', authorization: `Bearer ${token}` },
  });
  if (!token) await login();
  let upstream = await send();
  if (upstream.status === 401) { await login(); upstream = await send(); } // back réinitialisé ou jeton expiré
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await proxy(req, res);
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, path);
    if (!(await stat(file).catch(() => null))?.isFile()) file = join(ROOT, 'index.html'); // routes du front
    const content = await readFile(file).catch(() => null);
    if (!content) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('public/index.html manquant'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(String(err));
  }
}).listen(PORT, () => console.log(`front régénéré sur :${PORT}, back ${BACKEND}`));
