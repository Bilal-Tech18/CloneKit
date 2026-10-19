// Rapport de parité : HTML lisible par un humain, TICKETS.md + findings.json consommables par un agent.
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Channel, Finding, ScenarioResult, Severity } from './compare.js';
import { describeStep } from './scenario.js';

export interface GroupedFinding extends Finding {
  id: string;
  occurrences: { scenario: string; step: number; stepLabel: string }[];
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEV_LABEL: Record<Severity, string> = { high: 'Bloquant', medium: 'Important', low: 'Mineur' };
const CHANNEL_LABEL: Record<Channel, string> = { action: 'Action', url: 'Route', api: 'API', aria: 'Accessibilité', visual: 'Visuel' };

export function groupFindings(results: ScenarioResult[]): GroupedFinding[] {
  const map = new Map<string, GroupedFinding>();
  for (const f of results.flatMap((r) => r.findings)) {
    const occ = { scenario: f.scenario, step: f.step, stepLabel: f.stepLabel };
    const g = map.get(f.signature);
    if (g) g.occurrences.push(occ);
    else map.set(f.signature, { ...f, id: '', occurrences: [occ] });
  }
  return [...map.values()]
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.occurrences.length - a.occurrences.length)
    .map((g, i) => ({ ...g, id: `CK-${String(i + 1).padStart(3, '0')}` }));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (p: number, t: number) => (t ? Math.round((p / t) * 1000) / 10 : 100);

export async function writeReport(outDir: string, meta: { original: string; clone: string; startedAt: Date; durationMs: number }, results: ScenarioResult[]) {
  const grouped = groupFindings(results);
  const passed = results.reduce((a, r) => a + r.passed, 0);
  const total = results.reduce((a, r) => a + r.total, 0);
  const parity = pct(passed, total);
  const steps = (k: 'visual' | 'aria') => results.flatMap((r) => r.steps.length ? [r.similarity[k]] : []);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 1000) / 10 : 100);
  const similarity = { visual: avg(steps('visual')), aria: avg(steps('aria')) };
  const rel = (p?: string) => (p ? relative(outDir, p) : '');

  await writeFile(join(outDir, 'findings.json'), JSON.stringify({ parity, passed, total, similarity, ...meta, findings: grouped }, null, 2));

  // ---------- Tickets pour agents ----------
  const tickets = grouped.map((f) => {
    const first = f.occurrences[0];
    const scenario = results.find((r) => r.scenario.name === first.scenario)!.scenario;
    const repro = scenario.steps.slice(0, first.step + 1).map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n');
    return `## ${f.id} · [${SEV_LABEL[f.severity]}] ${f.title}

- **Canal** : ${CHANNEL_LABEL[f.channel]}
- **Vu** : ${f.occurrences.length} fois — ${[...new Set(f.occurrences.map((o) => o.scenario))].join(', ')}

**Reproduction** (scénario \`${first.scenario}\`) :
${repro}
${f.detail.length ? `\n**Détail** :\n\`\`\`\n${f.detail.join('\n')}\n\`\`\`\n` : ''}
**Critère d'acceptation** : \`npm run diff -- --only "${first.scenario}"\` ne remonte plus ce ticket.
`;
  });
  await writeFile(
    join(outDir, 'TICKETS.md'),
    `# Écarts de parité — ${grouped.length} tickets\n\nOriginal : ${meta.original} · Clone : ${meta.clone} · Parité : **${parity} %** (${passed}/${total} contrôles) · Similarité : pixels ${similarity.visual} %, arbre d'accessibilité ${similarity.aria} %\n\n${tickets.join('\n---\n\n')}`,
  );

  // ---------- HTML ----------
  const pill = (ok: boolean | null, ch: Channel) =>
    ok === null ? `<span class="pill na">${CHANNEL_LABEL[ch]}</span>` : `<span class="pill ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'} ${CHANNEL_LABEL[ch]}</span>`;

  const findingRows = grouped
    .map((f) => `<tr><td><code>${f.id}</code></td><td><span class="sev ${f.severity}">${SEV_LABEL[f.severity]}</span></td><td>${CHANNEL_LABEL[f.channel]}</td>
      <td>${esc(f.title)}${f.detail.length ? `<pre>${esc(f.detail.join('\n'))}</pre>` : ''}</td><td class="num">${f.occurrences.length}</td></tr>`)
    .join('');

  const scenarioBlocks = results
    .map((r) => {
      const steps = r.steps
        .map((s) => {
          const failed = Object.values(s.checks).some((v) => v === false);
          const shots = s.original && s.clone
            ? `<div class="shots"><figure><img loading="lazy" src="${rel(s.original.screenshot)}"><figcaption>Original</figcaption></figure>
               <figure><img loading="lazy" src="${rel(s.clone.screenshot)}"><figcaption>Clone</figcaption></figure>
               ${s.visual?.diffImage ? `<figure><img loading="lazy" src="${rel(s.visual.diffImage)}"><figcaption>Diff — ${(s.visual.ratio * 100).toFixed(2)} %</figcaption></figure>` : ''}</div>`
            : '';
          const errs = [s.original?.error && `Original : ${s.original.error}`, s.clone?.error && `Clone : ${s.clone.error}`].filter(Boolean).join('\n');
          return `<details ${failed ? '' : ''}><summary><span class="stepn">${s.step + 1}</span><span class="steplabel">${esc(s.label)}</span>
            <span class="pills">${(Object.keys(s.checks) as Channel[]).map((ch) => pill(s.checks[ch], ch)).join('')}</span></summary>
            <div class="body">
              ${errs ? `<h4>Erreurs</h4><pre>${esc(errs)}</pre>` : ''}
              ${s.apiDiff?.length ? `<h4>API</h4><pre>${esc(s.apiDiff.join('\n'))}</pre>` : ''}
              ${s.ariaDiff?.length ? `<h4>Accessibilité (ce que lit un agent)</h4><pre class="aria">${s.ariaDiff.map((l) => `<span class="${l.startsWith('+') ? 'add' : 'del'}">${esc(l)}</span>`).join('\n')}</pre>` : ''}
              ${shots}
            </div></details>`;
        })
        .join('');
      return `<section class="scenario"><header><h3>${esc(r.scenario.name)}</h3><span class="score ${pct(r.passed, r.total) === 100 ? 'ok' : 'ko'}">${pct(r.passed, r.total)} %</span></header>
        ${r.scenario.description ? `<p class="muted">${esc(r.scenario.description)}</p>` : ''}${steps}</section>`;
    })
    .join('');

  const noise = new Map<string, Finding>();
  for (const f of results.flatMap((r) => r.suppressed)) noise.set(f.signature, f);
  const noiseBlock = noise.size
    ? `<h2>Bruit calibré — ${noise.size} instabilité(s) de l'original, ignorée(s)</h2>
<p class="muted">L'original, rejoué deux fois dans les mêmes conditions, ne donne pas ces résultats à l'identique : ils ne peuvent pas servir de référence.</p>
<div class="tablewrap"><table><thead><tr><th>Canal</th><th>Instabilité</th></tr></thead><tbody>${[...noise.values()].map((f) => `<tr><td>${CHANNEL_LABEL[f.channel]}</td><td>${esc(f.title)}</td></tr>`).join('')}</tbody></table></div>`
    : '';

  const counts = (['high', 'medium', 'low'] as Severity[]).map((s) => [s, grouped.filter((g) => g.severity === s).length] as const);

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapport de parité</title><style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e6e4df;--ok:#1f7a4d;--okbg:#e5f4ec;--ko:#b42318;--kobg:#fdecea;--mid:#b54708;--midbg:#fef3e2;--low:#475467;--lowbg:#eef0f3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecebe8;--muted:#9b9a96;--line:#2e2e2b;--ok:#5fd39a;--okbg:#173225;--ko:#ff8a80;--kobg:#3a1714;--mid:#ffb35c;--midbg:#3a2510;--low:#b8c0cc;--lowbg:#262a30}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:36px 0 12px}h3{font-size:15px;margin:0}h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 6px}
.muted{color:var(--muted)}code{font:12px ui-monospace,monospace}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.kpi b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td,th{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
pre{font:12px/1.5 ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:6px 0 0;white-space:pre-wrap;word-break:break-word}
.aria .add{color:var(--ok)}.aria .del{color:var(--ko)}
.sev{font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap}.sev.high{background:var(--kobg);color:var(--ko)}.sev.medium{background:var(--midbg);color:var(--mid)}.sev.low{background:var(--lowbg);color:var(--low)}
.scenario{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.scenario header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.score{font-weight:700;font-variant-numeric:tabular-nums}.score.ok{color:var(--ok)}.score.ko{color:var(--ko)}
details{border-top:1px solid var(--line)}summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 0;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
.stepn{width:22px;height:22px;border-radius:50%;background:var(--bg);display:inline-grid;place-items:center;font-size:11px;font-weight:600}.steplabel{flex:1;min-width:200px}
.pills{display:flex;gap:4px;flex-wrap:wrap}.pill{font-size:11px;padding:1px 7px;border-radius:99px}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.ko{background:var(--kobg);color:var(--ko)}.pill.na{background:var(--bg);color:var(--muted)}
.body{padding:0 0 14px}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:12px}
figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:6px;display:block}figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.tablewrap{overflow-x:auto}
</style></head><body><main>
<h1>Rapport de parité original ↔ clone</h1>
<p class="muted">Original <code>${esc(meta.original)}</code> · Clone <code>${esc(meta.clone)}</code> · ${meta.startedAt.toLocaleString('fr-FR')} · ${(meta.durationMs / 1000).toFixed(1)} s</p>
<div class="kpis">
  <div class="kpi"><b>${parity} %</b><span>parité (${passed}/${total} contrôles)</span></div>
  <div class="kpi"><b>${similarity.visual} %</b><span>pixels identiques (moyenne)</span></div>
  <div class="kpi"><b>${similarity.aria} %</b><span>lignes d'accessibilité identiques</span></div>
  <div class="kpi"><b>${grouped.length}</b><span>écarts distincts</span></div>
  ${counts.map(([s, n]) => `<div class="kpi"><b>${n}</b><span>${SEV_LABEL[s]}</span></div>`).join('')}
  <div class="kpi"><b>${results.length}</b><span>scénarios rejoués</span></div>
</div>
<h2>Écarts (dédoublonnés → 1 ticket chacun)</h2>
<div class="tablewrap"><table><thead><tr><th>Id</th><th>Sévérité</th><th>Canal</th><th>Écart</th><th>Vu</th></tr></thead><tbody>${findingRows || '<tr><td colspan="5">Aucun écart 🎉</td></tr>'}</tbody></table></div>
${noiseBlock}
<h2>Détail par scénario</h2>
${scenarioBlocks}
</main></body></html>`;
  await writeFile(join(outDir, 'report.html'), html);
  return { parity, passed, total, similarity, findings: grouped };
}
