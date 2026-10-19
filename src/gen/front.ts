// Génération d'un front à partir d'une capture riche : un agent reconstruit les écrans
// (HTML/CSS/JS) à partir des captures d'écran, de l'arbre d'accessibilité, du snapshot stylé,
// des tokens et du catalogue d'API — sans jamais voir le code du front original.
// Ensuite, la boucle de correction (diff → agent → diff) prend le relais.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runAgent, type AgentRun } from '../fix/agent.js';
import { CloneServer, TOOL_DIR } from '../fix/loop.js';

export interface GenOptions {
  /** Dossier d'une capture faite avec la capture riche (states.json, styled/, assets/…). */
  capture: string;
  /** États de référence à reproduire (ids de states.json). */
  states: string[];
  /** Dossier de départ copié dans l'espace de travail (ex. le serveur qui relaie l'API). */
  harness: string;
  /** Commande qui sert le front depuis l'espace de travail (PORT fourni). */
  serve: string;
  /** URL où le front généré est servi. */
  clone: string;
  out: string;
  brief: string;
  budgetUsd: number;
  model?: string;
  denyBash?: RegExp[];
}

interface CapturedState { id: string; url: string; template: string; title: string; via: string[]; screenshot: string; aria: string; styled?: string; captureFidelity?: number }

/** Le snapshot stylé est écrit sur une ligne ; on le découpe entre les balises pour qu'un agent puisse le lire. */
const readable = (html: string) => html.replace(/></g, '>\n<');

async function prepare(o: GenOptions, workspace: string): Promise<string[]> {
  const { states } = JSON.parse(await readFile(join(o.capture, 'states.json'), 'utf8')) as { states: CapturedState[] };
  const ref = join(workspace, TOOL_DIR, 'reference');
  await mkdir(ref, { recursive: true });
  await cp(o.harness, workspace, { recursive: true });

  const lines: string[] = [];
  for (const id of o.states) {
    const s = states.find((x) => x.id === id);
    if (!s?.styled) throw new Error(`État ${id} absent de la capture ou capturé sans --rich`);
    await cp(join(o.capture, s.screenshot), join(ref, `${id}.png`));
    await cp(join(o.capture, s.aria), join(ref, `${id}.aria.yaml`));
    await writeFile(join(ref, `${id}.styled.html`), readable(await readFile(join(o.capture, s.styled), 'utf8')));
    lines.push(`- \`${id}\` — ${new URL(s.url).pathname} (« ${s.title} »), atteint par : ${s.via.join(' → ') || 'entrée'}`);
  }
  for (const f of ['tokens.css', 'design-tokens.json', 'endpoints.json']) await cp(join(o.capture, f), join(ref, f));

  // polices et images de l'original, mises à disposition du front (pas ses scripts ni ses feuilles de style)
  const assets = JSON.parse(await readFile(join(o.capture, 'assets.json'), 'utf8')) as { url: string; type: string; file: string }[];
  const media: string[] = [];
  await mkdir(join(workspace, 'public', 'assets'), { recursive: true });
  for (const a of assets.filter((x) => x.type === 'font' || x.type === 'image')) {
    const name = basename(a.file);
    await cp(join(o.capture, a.file), join(workspace, 'public', 'assets', name));
    media.push(`- \`/assets/${name}\` (${a.type}, original : ${new URL(a.url).pathname})`);
  }
  return [...lines, '', '**Polices et images disponibles** (déjà copiées dans `public/assets/`) :', ...media];
}

function prompt(o: GenOptions, refs: string[]): string {
  return `Tu reconstruis le front d'une application web, écran par écran, à partir d'une capture. Tu n'as pas son code source.

## Objectif
Écrire dans \`public/\` un front **indiscernable de l'original pour un agent IA** :
- **même arbre d'accessibilité** (rôles, noms accessibles, hiérarchie, ordre) — c'est ce qu'un agent lit ;
- **même rendu au pixel près** à 1280×800 — c'est ce qu'un agent voit ;
- **mêmes routes** et **mêmes interactions**, avec les **vraies données** lues depuis l'API (pas de contenu codé en dur).

## Références (dans \`${TOOL_DIR}/reference/\`, lecture seule)
Pour chaque écran de référence :
- \`<id>.png\` : capture d'écran de l'original (regarde-la avec Read) ;
- \`<id>.aria.yaml\` : arbre d'accessibilité de l'original (format Playwright ariaSnapshot) ;
- \`<id>.styled.html\` : DOM de l'original **avec ses styles calculés inlinés** (attribut \`style\`) et la boîte de chaque élément (\`data-ck-box="x,y,largeur,hauteur"\`). C'est ta source principale pour les valeurs CSS exactes (couleurs, tailles, espacements, polices). Les \`<span data-ck-pseudo>\` représentent des pseudo-éléments ::before/::after.

Écrans de référence :
${refs.join('\n')}

Communs : \`tokens.css\` / \`design-tokens.json\` (tokens de design les plus utilisés), \`endpoints.json\` (endpoints appelés par l'original, avec schémas et exemples de réponses).

${o.brief}

## Règles
1. Écris le front dans \`public/\` (\`index.html\` + CSS + JS). JavaScript natif en modules ES, pas d'étape de build, aucune ressource externe (CDN, Google Fonts…).
2. Ne modifie pas \`server.mjs\`.
3. Interroge l'API avec \`curl\` pour connaître les données et leur forme. Ne télécharge **pas** le HTML, le JS ni le CSS du front original : c'est une reconstruction, pas une copie.
4. Reproduis les détails qui comptent pour un agent : libellés exacts, \`aria-label\`, ordre des éléments, états (coché, désactivé, \`aria-expanded\`), textes calculés (dates relatives…).
5. Vérifie la syntaxe de chaque fichier JS avec \`node --check\`.
6. Termine par un résumé court : ce que tu as reproduit, ce que tu as laissé de côté, et tes incertitudes.`;
}

export async function generateFront(o: GenOptions, log: (l: string) => void = console.log): Promise<{ workspace: string; agent: AgentRun }> {
  const workspace = join(o.out, 'workspace');
  await rm(o.out, { recursive: true, force: true });
  await mkdir(o.out, { recursive: true });
  const refs = await prepare(o, workspace);
  const p = prompt(o, refs);
  await writeFile(join(o.out, 'prompt.md'), p);

  // le harnais tourne pendant la génération : l'agent peut interroger l'API à travers lui
  const server = new CloneServer(workspace, o.serve, o.clone, join(o.out, 'server.log'));
  await server.start();
  log(`  génération du front à partir de ${o.states.join(', ')}…`);
  try {
    const agent = await runAgent({
      cwd: workspace, prompt: p, logFile: join(o.out, 'agent.jsonl'), budgetUsd: o.budgetUsd, model: o.model,
      timeoutMs: 45 * 60_000, denyBash: o.denyBash,
    });
    await writeFile(join(o.out, 'gen-summary.json'), JSON.stringify({
      ok: agent.ok, stopReason: agent.stopReason, costUsd: agent.costUsd, turns: agent.turns, durationMs: agent.durationMs,
      toolCalls: agent.toolCalls.length, violations: agent.toolCalls.filter((c) => c.violation).map((c) => `[${c.denied ? 'refusé' : 'exécuté'}] ${c.violation}`),
      summary: agent.summary,
    }, null, 2));
    return { workspace, agent };
  } finally {
    await server.stop();
  }
}
