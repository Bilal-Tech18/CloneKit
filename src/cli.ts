#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { crawl } from './capture/crawler.js';
import { runDiff } from './diff/run.js';
import { fixLoop } from './fix/loop.js';
import { generateFront } from './gen/front.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const program = new Command().name('clonekit').description('Capture agentique et diff de parité original ↔ clone');

program
  .command('capture')
  .description("Explore une app et en déduit états, endpoints, schémas et modèle de données")
  .argument('<url>', "URL d'entrée de l'app à explorer")
  .option('-o, --out <dir>', 'dossier de sortie')
  .option('--max-states <n>', "nombre max d'états distincts", '40')
  .option('--max-depth <n>', "profondeur max d'exploration", '3')
  .option('--max-actions <n>', 'actions explorées par état', '25')
  .option('--reset-path <path>', "endpoint POST de réinitialisation appelé avant chaque rejeu")
  .option('--reset-cmd <cmd>', 'commande shell de réinitialisation ({url} = URL de la cible)')
  .option('--storage-state <file>', 'session Playwright (cookies) pour une app authentifiée')
  .option('--deny <regex>', 'libellés à ne jamais cliquer', 'delete|remove|supprimer|logout|log out|sign out|déconnexion|^✕$')
  .option('--probe <text>', 'texte saisi dans les champs pendant l’exploration', 'CloneKit probe')
  .option('--no-rich', 'ne capture pas le DOM, les styles ni les ressources (exploration seule)')
  .option('-s, --scenarios <dir>', 'scénarios rejoués en plus de l’exploration pour enrichir le catalogue d’API')
  .action(async (url: string, o) => {
    const out = resolve(o.out ?? `out/capture-${new URL(url).host.replace(/[:.]/g, '_')}-${stamp()}`);
    console.log(`Exploration de ${url} → ${out}`);
    const t0 = Date.now();
    const r = await crawl({
      url, out, maxStates: +o.maxStates, maxDepth: +o.maxDepth, maxActionsPerState: +o.maxActions,
      resetPath: o.resetPath, resetCmd: o.resetCmd, storageState: o.storageState, denyPattern: new RegExp(o.deny, 'i'), probeText: o.probe, rich: o.rich, scenarios: o.scenarios,
    });
    console.log(`\n✔ ${r.states.length} états, ${r.edges.length} transitions, ${r.endpoints.length} endpoints, entités : ${r.entities.join(', ') || '—'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(`  Résumé : ${join(out, 'SUMMARY.md')}`);
  });

program
  .command('diff')
  .description('Rejoue des scénarios sur l’original et le clone, compare et produit un rapport de parité')
  .requiredOption('--original <url>', 'URL de l’original')
  .requiredOption('--clone <url>', 'URL du clone')
  .option('-s, --scenarios <dir>', 'dossier de scénarios JSON', 'scenarios')
  .option('-o, --out <dir>', 'dossier de sortie')
  .option('--only <name>', 'ne rejouer que ce scénario')
  .option('--reset-path <path>', 'endpoint POST de réinitialisation (appelé des deux côtés avant chaque scénario)')
  .option('--reset-cmd <cmd>', 'commande shell de réinitialisation, lancée pour chaque côté ({url} = URL de la cible)')
  .option('--storage-original <file>', 'session Playwright côté original')
  .option('--storage-clone <file>', 'session Playwright côté clone')
  .option('--fail-under <pct>', 'code de sortie 1 si la parité est inférieure (CI)')
  .option('--calibrate-runs <n>', "nombre de rejeux supplémentaires de l'original pour apprendre son bruit (non-déterminisme)", '2')
  .option('--no-calibrate', 'désactive la calibration')
  .option('--channels <list>', 'canaux évalués, séparés par des virgules (action,url,api,aria,visual)')
  .action(async (o) => {
    const rep = await runDiff({
      channels: o.channels?.split(','),
      original: o.original, clone: o.clone, scenarios: o.scenarios, out: resolve(o.out ?? `out/diff-${stamp()}`), only: o.only,
      resetPath: o.resetPath, resetCmd: o.resetCmd, storageOriginal: o.storageOriginal, storageClone: o.storageClone,
      calibrate: o.calibrate, calibrateRuns: +o.calibrateRuns,
    });
    console.log(`\nParité globale : ${rep.parity} % (${rep.passed}/${rep.total}) — ${rep.findings.length} écarts distincts · pixels identiques ${rep.similarity.visual} %, accessibilité ${rep.similarity.aria} %`);
    for (const f of rep.findings) console.log(`  ${f.id} [${f.severity}] ${f.title}${f.occurrences.length > 1 ? ` (×${f.occurrences.length})` : ''}`);
    console.log(`\n  Rapport : ${join(rep.out, 'report.html')}\n  Tickets : ${join(rep.out, 'TICKETS.md')}`);
    if (o.failUnder && rep.parity < +o.failUnder) process.exitCode = 1;
  });

program
  .command('fix')
  .description("Boucle de correction : un agent corrige le clone à partir des tickets jusqu'à la parité")
  .requiredOption('--original <url>', "URL de l'original (boîte noire)")
  .requiredOption('--clone <url>', 'URL à laquelle servir le clone')
  .requiredOption('--source <dir>', 'code source de départ du clone (copié, jamais modifié)')
  .requiredOption('--serve <cmd>', "commande qui lance le clone depuis son dossier (PORT fourni)")
  .option('-s, --scenarios <dir>', 'dossier de scénarios JSON', 'scenarios')
  .option('-o, --out <dir>', 'dossier de sortie')
  .option('--reset-path <path>', 'endpoint POST de réinitialisation')
  .option('--reset-cmd <cmd>', 'commande shell de réinitialisation ({url} = URL de la cible)')
  .option('--storage-original <file>', 'session Playwright côté original')
  .option('--storage-clone <file>', 'session Playwright côté clone')
  .option('--channels <list>', 'canaux évalués (action,url,api,aria,visual)')
  .option('--brief <file>', 'contexte propre à la cible, ajouté au prompt de l’agent')
  .option('--max-iterations <n>', "nombre max d'itérations", '4')
  .option('--budget <usd>', "budget max de l'agent par itération (USD)", '5')
  .option('--model <model>', "modèle de l'agent (défaut : celui de Claude Code)")
  .action(async (o) => {
    const out = resolve(o.out ?? `out/fix-${stamp()}`);
    console.log(`Boucle de correction → ${out}`);
    const s = await fixLoop({
      original: o.original, clone: o.clone, source: resolve(o.source), serve: o.serve, scenarios: resolve(o.scenarios), out,
      resetPath: o.resetPath, resetCmd: o.resetCmd, storageOriginal: o.storageOriginal, storageClone: o.storageClone,
      channels: o.channels?.split(','), brief: o.brief && (await readFile(o.brief, 'utf8')), maxIterations: +o.maxIterations, budgetUsd: +o.budget, model: o.model,
    });
    const cost = s.iterations.reduce((a, i) => a + i.agent.costUsd, 0);
    console.log(`\nParité ${s.startParity} % → ${s.endParity} % en ${s.iterations.length} itération(s), ${cost.toFixed(2)} $, ${(s.durationMs / 60000).toFixed(1)} min`);
    console.log(`  Rapport : ${join(out, 'fix-report.html')}\n  Correctif total : ${join(out, 'total.patch.diff')}`);
    if (s.endParity < 100) process.exitCode = 1;
  });

program
  .command('gen-front')
  .description("Génère un front à partir d'une capture riche, puis le fait converger avec la boucle de correction")
  .requiredOption('--capture <dir>', 'dossier de capture (avec DOM stylé et ressources)')
  .requiredOption('--states <ids>', 'états de référence, séparés par des virgules (ex. s12,s14)')
  .requiredOption('--harness <dir>', "dossier de départ (serveur qui sert public/ et relaie l'API)")
  .requiredOption('--original <url>', "URL de l'original")
  .requiredOption('--clone <url>', 'URL où servir le front généré')
  .option('--serve <cmd>', 'commande qui lance le front (PORT fourni)', 'node server.mjs')
  .option('--brief <file>', 'contexte propre à la cible')
  .option('-s, --scenarios <dir>', 'scénarios de vérification')
  .option('-o, --out <dir>', 'dossier de sortie')
  .option('--reset-cmd <cmd>', 'commande shell de réinitialisation ({url})')
  .option('--storage-original <file>', 'session Playwright côté original')
  .option('--channels <list>', 'canaux évalués', 'action,url,aria,visual')
  .option('--budget <usd>', 'budget max de la génération (USD)', '20')
  .option('--fix-iterations <n>', "itérations de correction après la génération (0 = aucune)", '3')
  .option('--fix-budget <usd>', 'budget max par itération de correction (USD)', '8')
  .option('--model <model>', "modèle de l'agent")
  .action(async (o) => {
    const out = resolve(o.out ?? `out/gen-front-${stamp()}`);
    const brief = o.brief ? await readFile(o.brief, 'utf8') : '';
    // l'agent ne doit pas récupérer le front original (HTML/JS/CSS) : seule son API est permise
    const origin = new URL(o.original).host.replace(/[.]/g, '\\.');
    const denyBash = [new RegExp(`${origin}(?!/api/)`)];
    console.log(`Génération du front → ${out}`);
    const t0 = Date.now();
    const gen = await generateFront({
      capture: resolve(o.capture), states: o.states.split(','), harness: resolve(o.harness), serve: o.serve, clone: o.clone,
      out: join(out, 'gen'), brief, budgetUsd: +o.budget, model: o.model, denyBash,
    });
    const v = gen.agent.toolCalls.filter((c) => c.violation);
    console.log(`  génération : ${gen.agent.stopReason}, ${gen.agent.turns} tours, ${(gen.agent.durationMs / 60000).toFixed(1)} min, ${gen.agent.costUsd.toFixed(2)} $${v.length ? ` · ⚠ ${v.map((c) => c.violation).join(' ; ')}` : ''}`);
    if (!o.scenarios) return;
    const s = await fixLoop({
      original: o.original, clone: o.clone, source: gen.workspace, serve: o.serve, scenarios: resolve(o.scenarios), out: join(out, 'fix'),
      resetCmd: o.resetCmd, storageOriginal: o.storageOriginal, channels: o.channels.split(','), brief, denyBash,
      maxIterations: +o.fixIterations, budgetUsd: +o.fixBudget, model: o.model,
    });
    const cost = gen.agent.costUsd + s.iterations.reduce((a, i) => a + i.agent.costUsd, 0);
    console.log(`\nPremier jet : parité ${s.startParity} %, pixels ${s.startSimilarity.visual} %, accessibilité ${s.startSimilarity.aria} %`);
    console.log(`Après ${s.iterations.length} itération(s) : parité ${s.endParity} %, pixels ${s.endSimilarity.visual} %, accessibilité ${s.endSimilarity.aria} %`);
    console.log(`Coût estimé ${cost.toFixed(2)} $ · ${((Date.now() - t0) / 60000).toFixed(1)} min\n  Rapport : ${join(out, 'fix', 'fix-report.html')}`);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
