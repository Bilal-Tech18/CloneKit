// Boucle de correction : diff → l'agent corrige le clone à partir des tickets → redémarrage → diff.
// Garde-fous : l'agent ne voit que le code du clone, l'original est une boîte noire HTTP ;
// toute itération qui fait baisser la parité est annulée (rollback des fichiers).
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Channel } from '../diff/compare.js';
import { runDiff, type DiffOptions } from '../diff/run.js';
import { runAgent, type AgentRun } from './agent.js';

export interface FixOptions {
  original: string;
  clone: string;
  /** Code source de départ du clone (copié dans un espace de travail, jamais modifié). */
  source: string;
  /** Commande qui lance le clone depuis l'espace de travail (PORT fourni en variable d'env). */
  serve: string;
  scenarios: string;
  out: string;
  resetPath?: string;
  resetCmd?: string;
  storageOriginal?: string;
  storageClone?: string;
  channels?: Channel[];
  /** Contexte propre à la cible, ajouté au prompt (ex. « front régénéré, le back est partagé »). */
  brief?: string;
  denyBash?: RegExp[];
  maxIterations: number;
  budgetUsd: number;
  model?: string;
}

/** Dossier de l'espace de travail réservé à l'outil (références, captures du dernier diff) : lu par l'agent, jamais versionné. */
export const TOOL_DIR = '.ck';

interface Iteration {
  n: number;
  before: number;
  after: number;
  similarityBefore: { visual: number; aria: number };
  similarityAfter: { visual: number; aria: number };
  closed: string[];
  opened: string[];
  remaining: string[];
  rolledBack: boolean;
  agent: AgentRun;
  patch: string;
  changedFiles: string[];
}

type Snapshot = Map<string, Buffer>;

const tracked = (rel: string) => !rel.startsWith(TOOL_DIR + '/') && !rel.split('/').includes('node_modules');

async function snapshot(dir: string): Promise<Snapshot> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((d) => d.isFile());
  const snap: Snapshot = new Map();
  for (const f of files) {
    const full = join(f.parentPath, f.name);
    if (tracked(relative(dir, full))) snap.set(relative(dir, full), await readFile(full));
  }
  return snap;
}

async function restore(dir: string, snap: Snapshot): Promise<void> {
  for (const rel of (await snapshot(dir)).keys()) if (!snap.has(rel)) await rm(join(dir, rel));
  for (const [rel, content] of snap) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
}

const text = (b?: Buffer) => (!b ? '' : b.includes(0) ? '(fichier binaire)\n' : b.toString('utf8'));

function patchOf(before: Snapshot, after: Snapshot): { patch: string; files: string[] } {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = names.filter((n) => !(before.get(n) && after.get(n) && before.get(n)!.equals(after.get(n)!)));
  const patch = changed.map((n) => createTwoFilesPatch(`a/${n}`, `b/${n}`, text(before.get(n)), text(after.get(n)), '', '', { context: 2 })).join('\n');
  return { patch, files: changed };
}

/** Copie les captures du dernier diff dans l'espace de travail, pour que l'agent puisse les regarder. */
async function exposeDiff(diffOut: string, workspace: string): Promise<void> {
  const dest = join(workspace, TOOL_DIR, 'last-diff');
  await rm(dest, { recursive: true, force: true });
  await cp(diffOut, dest, { recursive: true, filter: (src) => !/original-calib-/.test(src) && !/report\.html$/.test(src) });
}

// ---------- serveur du clone ----------

export class CloneServer {
  private child?: ChildProcess;
  constructor(private cwd: string, private cmd: string, private url: string, private logFile: string) {}

  async start(): Promise<void> {
    const port = new URL(this.url).port;
    const log = openSync(this.logFile, 'a');
    this.child = spawn(this.cmd, { cwd: this.cwd, shell: true, detached: true, env: { ...process.env, PORT: port }, stdio: ['ignore', log, log] });
    for (let i = 0; i < 100; i++) {
      if (this.child.exitCode !== null) throw new Error(`Le clone a planté au démarrage (code ${this.child.exitCode}) — voir ${this.logFile}`);
      try { await fetch(this.url); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error(`Le clone ne répond pas sur ${this.url}`);
  }

  async stop(): Promise<void> {
    if (!this.child?.pid) return;
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* déjà arrêté */ }
    await new Promise((r) => setTimeout(r, 300));
    this.child = undefined;
  }
}

// ---------- prompt ----------

function prompt(o: FixOptions, tickets: string, n: number, feedback: string): string {
  return `Tu es l'agent de correction d'un clone logiciel. Itération ${n}.

## Contexte
- Le dossier courant contient le **code source du clone**. C'est le seul code que tu peux lire et modifier.
- Le **produit original** tourne sur ${o.original}. C'est une **boîte noire** : tu n'as pas son code, tu ne peux que l'interroger en HTTP avec \`curl\` (pages HTML, API JSON). Préfère les requêtes GET ; si tu dois tester une écriture, sache que l'environnement est réinitialisé avant chaque vérification.
- Le clone tourne sur ${o.clone} dans sa version actuelle. Il sera redémarré automatiquement après ta passe, puis un outil de comparaison rejouera des scénarios sur les deux et vérifiera tes corrections.
- Les captures d'écran du dernier diff sont dans \`${TOOL_DIR}/last-diff/<scénario>/\` : \`original/step-N.png\`, \`clone/step-N.png\` et \`visual-N.png\` (pixels différents en rouge). Regarde-les avec Read.
${o.brief ? `\n## Contexte propre à cette cible\n${o.brief}\n` : ''}
## Objectif
Faire disparaître les écarts listés ci-dessous en rendant le clone **indiscernable de l'original** : mêmes réponses d'API, même écran, mêmes règles métier — y compris les bizarreries de l'original (si l'original a une faute ou un comportement étrange, le clone doit la reproduire).

## Règles
1. Avant chaque modification, **vérifie le comportement réel de l'original avec curl**. Ne devine pas.
2. Ne modifie que les fichiers du dossier courant${o.brief ? ` (\`${TOOL_DIR}/\` est en lecture seule)` : ". N'en crée pas d'autres"}.
3. Corrige la cause, pas le symptôme : pas de code qui détecte l'outil de comparaison ou des scénarios précis.
4. Un écart peut être la conséquence d'un autre (ex. un appel en trop parce qu'une validation manque) : traite la cause et l'effet suivra.
5. Après tes modifications, vérifie la syntaxe avec \`node --check <fichier>\`.
6. Termine par un résumé court : pour chaque ticket, « corrigé » ou « non corrigé » avec la raison, et ce que tu as observé sur l'original.
${feedback ? `\n## Retour de l'itération précédente\n${feedback}\n` : ''}
## Écarts à corriger (générés par l'outil de comparaison)

${tickets.length > 40_000 ? tickets.slice(0, 40_000) + '\n…(tronqué)' : tickets}`;
}

// ---------- boucle ----------

export async function fixLoop(o: FixOptions, log: (l: string) => void = console.log) {
  const workspace = join(o.out, 'workspace');
  await rm(o.out, { recursive: true, force: true });
  await mkdir(o.out, { recursive: true });
  await cp(o.source, workspace, { recursive: true });
  const initial = await snapshot(workspace);
  const server = new CloneServer(workspace, o.serve, o.clone, join(o.out, 'clone.log'));
  const diffOpts = (n: number): DiffOptions => ({
    original: o.original, clone: o.clone, scenarios: o.scenarios, out: join(o.out, `iter-${n}`, 'diff'),
    resetPath: o.resetPath, resetCmd: o.resetCmd, storageOriginal: o.storageOriginal, storageClone: o.storageClone,
    channels: o.channels, calibrate: true, calibrateRuns: 1, log: () => {},
  });
  const metrics = (r: { parity: number; similarity: { visual: number; aria: number } }) =>
    `parité ${r.parity} % · pixels ${r.similarity.visual} % · accessibilité ${r.similarity.aria} %`;

  const iterations: Iteration[] = [];
  const started = Date.now();
  let feedback = '';
  try {
    await server.start();
    let current = await runDiff(diffOpts(0));
    const startParity = current.parity;
    const startSimilarity = current.similarity;
    log(`  itération 0 · ${metrics(current)} · ${current.findings.length} tickets`);

    for (let n = 1; n <= o.maxIterations && current.parity < 100; n++) {
      const before = await snapshot(workspace);
      await exposeDiff(current.out, workspace);
      const tickets = await readFile(join(current.out, 'TICKETS.md'), 'utf8');
      await mkdir(join(o.out, `iter-${n}`), { recursive: true });
      log(`  itération ${n} · l'agent corrige ${current.findings.length} tickets…`);
      const agent = await runAgent({
        cwd: workspace, prompt: prompt(o, tickets, n, feedback), logFile: join(o.out, `iter-${n}`, 'agent.jsonl'),
        budgetUsd: o.budgetUsd, model: o.model, denyBash: o.denyBash,
      });
      const after = await snapshot(workspace);
      const { patch, files } = patchOf(before, after);

      await server.stop();
      let next;
      try {
        await server.start();
        next = await runDiff(diffOpts(n));
      } catch (err) {
        next = undefined;
        feedback = `Ta modification a empêché le clone de démarrer (${(err as Error).message}). Elle a été annulée.`;
      }

      const ids = (r: typeof current) => new Map(r.findings.map((f) => [f.signature, `${f.id} ${f.title}`]));
      const prev = ids(current);
      // à parité égale, on garde la passe si elle rapproche le rendu (mesures continues)
      const score = (r: typeof current) => r.parity * 1e4 + r.similarity.visual * 10 + r.similarity.aria / 10;
      const rolledBack = !next || score(next) < score(current);
      const it: Iteration = {
        n, before: current.parity, after: next?.parity ?? current.parity, rolledBack,
        similarityBefore: current.similarity, similarityAfter: next?.similarity ?? current.similarity, agent, patch, changedFiles: files,
        closed: next ? [...prev].filter(([s]) => !ids(next).has(s)).map(([, t]) => t) : [],
        opened: next ? [...ids(next)].filter(([s]) => !prev.has(s)).map(([, t]) => t) : [],
        remaining: next ? [...ids(next)].map(([, t]) => t) : [...prev.values()],
      };
      iterations.push(it);
      await writeFile(join(o.out, `iter-${n}`, 'patch.diff'), patch);

      if (rolledBack) {
        await server.stop();
        await restore(workspace, before);
        await server.start();
        if (next) feedback = `Ta passe précédente a fait BAISSER le score (${metrics(current)} → ${metrics(next)}). Elle a été annulée. Nouveaux écarts qu'elle avait introduits :\n${it.opened.map((t) => `- ${t}`).join('\n')}`;
        log(`  itération ${n} · ✗ régression (${next ? metrics(next) : 'crash'}) → annulée · ${agent.costUsd.toFixed(2)} $`);
      } else {
        feedback = it.remaining.length ? `Tickets encore ouverts après ta passe précédente :\n${it.remaining.map((t) => `- ${t}`).join('\n')}` : '';
        log(`  itération ${n} · ${metrics(next!)} · ${it.closed.length} fermés, ${it.opened.length} nouveaux · ${agent.costUsd.toFixed(2)} $ · ${files.join(', ') || 'aucun fichier modifié'}`);
        current = next!;
      }
      const violations = agent.toolCalls.filter((c) => c.violation);
      if (violations.length) log(`    ⚠ ${violations.length} appel(s) hors liste blanche : ${violations.map((v) => `[${v.denied ? 'refusé' : 'exécuté'}] ${v.violation}`).join(' ; ')}`);
    }

    const final = await snapshot(workspace);
    const total = patchOf(initial, final);
    await writeFile(join(o.out, 'total.patch.diff'), total.patch);
    const summary = { startParity, endParity: current.parity, startSimilarity, endSimilarity: current.similarity, iterations, durationMs: Date.now() - started, finalDiff: current.out };
    await writeFile(join(o.out, 'fix-report.html'), renderHtml(o, summary, total.patch));
    await writeFile(join(o.out, 'fix-summary.json'), JSON.stringify({ ...summary, iterations: iterations.map(({ patch, agent, ...i }) => ({ ...i, cost: agent.costUsd, turns: agent.turns, toolCalls: agent.toolCalls.length, violations: agent.toolCalls.filter((c) => c.violation).map((c) => c.violation) })) }, null, 2));
    return summary;
  } finally {
    await server.stop();
  }
}

// ---------- rapport ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function renderPatch(patch: string): string {
  return patch
    .split('\n')
    .filter((l) => !l.startsWith('===') && !/^(Index|---|\+\+\+) /.test(l))
    .map((l) => `<span class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l)}</span>`)
    .join('\n');
}

function renderHtml(o: FixOptions, s: { startParity: number; endParity: number; startSimilarity: { visual: number; aria: number }; endSimilarity: { visual: number; aria: number }; iterations: Iteration[]; durationMs: number; finalDiff: string }, totalPatch: string): string {
  const cost = s.iterations.reduce((a, i) => a + i.agent.costUsd, 0);
  const calls = s.iterations.reduce((a, i) => a + i.agent.toolCalls.length, 0);
  const curls = s.iterations.reduce((a, i) => a + i.agent.toolCalls.filter((c) => c.name === 'Bash' && /^curl/.test(String(c.input.command))).length, 0);
  const violations = s.iterations.flatMap((i) => i.agent.toolCalls.filter((c) => c.violation));
  const bar = (p: number) => `<span class="bar"><span style="width:${p}%"></span></span>`;
  const items = s.iterations.map((it) => `
  <section class="iter ${it.rolledBack ? 'rb' : ''}">
    <header><h3>Itération ${it.n}</h3><span class="par">${it.before} % → <b>${it.after} %</b> · pixels ${it.similarityBefore.visual} % → ${it.similarityAfter.visual} % · accessibilité ${it.similarityBefore.aria} % → ${it.similarityAfter.aria} %</span>${it.rolledBack ? '<span class="tag ko">régression → annulée</span>' : ''}</header>
    ${bar(it.after)}
    <p class="muted">${it.agent.turns} tours · ${it.agent.toolCalls.length} appels d'outils dont ${it.agent.toolCalls.filter((c) => c.name === 'Bash' && /^curl/.test(String(c.input.command))).length} requêtes sur l'original · ${(it.agent.durationMs / 1000).toFixed(0)} s · ${it.agent.costUsd.toFixed(2)} $ · fichiers : ${it.changedFiles.map((f) => `<code>${esc(f)}</code>`).join(', ') || 'aucun'}</p>
    <div class="cols">
      <div><h4>Tickets fermés (${it.closed.length})</h4><ul>${it.closed.map((t) => `<li class="ok">${esc(t)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
      <div><h4>Encore ouverts (${it.remaining.length})</h4><ul>${it.remaining.map((t) => `<li>${esc(t)}</li>`).join('') || '<li class="muted">aucun</li>'}</ul>
      ${it.opened.length ? `<h4>Nouveaux (${it.opened.length})</h4><ul>${it.opened.map((t) => `<li class="ko">${esc(t)}</li>`).join('')}</ul>` : ''}</div>
    </div>
    <details><summary>Ce que l'agent dit avoir fait</summary><pre>${esc(it.agent.summary || '(pas de résumé)')}</pre></details>
    <details><summary>Requêtes de l'agent sur l'original</summary><pre>${esc(it.agent.toolCalls.filter((c) => c.name === 'Bash').map((c) => `${c.violation ? '⚠ ' : c.denied ? '✗ ' : ''}${String(c.input.command)}`).join('\n') || '—')}</pre></details>
    <details><summary>Correctif appliqué</summary><pre class="patch">${renderPatch(it.patch) || 'aucune modification'}</pre></details>
  </section>`).join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boucle de correction</title><style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e6e4df;--ok:#1f7a4d;--okbg:#e5f4ec;--ko:#b42318;--kobg:#fdecea;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecebe8;--muted:#9b9a96;--line:#2e2e2b;--ok:#5fd39a;--okbg:#173225;--ko:#ff8a80;--kobg:#3a1714;--accent:#8b84ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 12px}h3{font-size:15px;margin:0}h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:12px 0 6px}
.muted{color:var(--muted)}code{font:12px ui-monospace,monospace}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:12px}
.iter{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}.iter.rb{border-color:var(--ko)}
.iter header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.par{font-variant-numeric:tabular-nums}
.tag{font-size:11px;padding:2px 8px;border-radius:99px}.tag.ko{background:var(--kobg);color:var(--ko)}
.bar{display:block;height:6px;background:var(--bg);border-radius:99px;margin:10px 0;overflow:hidden}.bar span{display:block;height:100%;background:var(--accent)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}ul{margin:0;padding-left:18px}li{margin:2px 0}li.ok{color:var(--ok)}li.ko{color:var(--ko)}
details{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}summary{cursor:pointer;font-weight:500}
pre{font:12px/1.5 ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;max-height:480px;overflow:auto}
.patch .add{color:var(--ok)}.patch .del{color:var(--ko)}.patch .hunk{color:var(--muted)}
</style></head><body><main>
<h1>Boucle de correction automatique</h1>
<p class="muted">Original <code>${esc(o.original)}</code> (boîte noire) · Clone <code>${esc(o.clone)}</code> · ${new Date().toLocaleString('fr-FR')}</p>
<div class="kpis">
  <div class="kpi"><b>${s.startParity} % → ${s.endParity} %</b><span>parité</span></div>
  <div class="kpi"><b>${s.startSimilarity.visual} % → ${s.endSimilarity.visual} %</b><span>pixels identiques</span></div>
  <div class="kpi"><b>${s.startSimilarity.aria} % → ${s.endSimilarity.aria} %</b><span>accessibilité identique</span></div>
  <div class="kpi"><b>${s.iterations.length}</b><span>itérations</span></div>
  <div class="kpi"><b>${curls}</b><span>requêtes de l'agent sur l'original (sur ${calls} appels d'outils)</span></div>
  <div class="kpi"><b>${violations.length}</b><span>appel(s) hors liste blanche (${violations.filter((v) => v.denied).length} refusé(s))</span></div>
  <div class="kpi"><b>${cost.toFixed(2)} $</b><span>coût agent · ${(s.durationMs / 60000).toFixed(1)} min au total</span></div>
</div>
<p class="muted">Garde-fous : l'agent ne lit que le code du clone (outils de fichiers confinés), son shell est limité à <code>curl</code> et <code>node --check</code>, toute itération qui fait baisser la parité est annulée, et la vérification est faite par l'outil de comparaison, pas par l'agent. Rapport de parité final : <code>${esc(relative(o.out, join(s.finalDiff, 'report.html')))}</code></p>
${violations.length ? `<h2>Appels hors liste blanche</h2><p class="muted">« refusé » : bloqué par le bac à sable. « exécuté » : jugé sans risque par Claude Code (ex. lecture dans le dossier du clone) mais hors de la liste blanche de l'audit — à surveiller.</p><pre>${esc(violations.map((v) => `[${v.denied ? 'refusé' : 'exécuté'}] ${v.violation}`).join('\n'))}</pre>` : ''}
<h2>Itérations</h2>${items}
<h2>Correctif total</h2><pre class="patch">${renderPatch(totalPatch) || 'aucun'}</pre>
</main></body></html>`;
}
