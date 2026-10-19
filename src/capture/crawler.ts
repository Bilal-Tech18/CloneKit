// Crawler d'exploration : parcourt l'app en largeur, état par état, en rejouant chaque
// chemin depuis un environnement réinitialisé. Produit le graphe d'états, le catalogue
// d'endpoints, les schémas inférés et un brouillon Prisma.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { activate, launch, newContext, NetworkRecorder, resetTarget, settle, type ApiCall } from '../shared/browser.js';
import { runScenario, type Scenario } from '../diff/scenario.js';
import { normalizeJson, structuralSignature, templateUrl } from '../shared/normalize.js';
import { AssetCollector, captureFidelity, captureRich, mergeTokens, renderTokens, type TokenCounts } from './rich.js';
import { emptyShape, entityFromTemplate, entityShape, mergeInto, observe, toJsonSchema, toPrisma, type Shape } from './schema.js';

export interface CrawlOptions {
  url: string;
  out: string;
  maxStates: number;
  maxDepth: number;
  maxActionsPerState: number;
  resetPath?: string;
  resetCmd?: string;
  storageState?: string;
  /** Libellés jamais cliqués (actions destructrices / déconnexion). */
  denyPattern: RegExp;
  probeText: string;
  /** Capture riche (DOM, styles calculés, tokens, ressources) pour reconstruire le front. */
  rich: boolean;
  /** Scénarios rejoués en plus de l'exploration : leurs appels enrichissent le catalogue (écritures, erreurs). */
  scenarios?: string;
}

export interface Action {
  kind: 'click' | 'fill-submit' | 'escape';
  role: string;
  name: string;
  nth: number;
  /** Action à l'intérieur de la boîte de dialogue ouverte (le reste de la page est inaccessible). */
  inDialog?: boolean;
}

interface QueueItem { path: Action[]; parentId?: string }

interface StateRecord {
  id: string;
  url: string;
  template: string;
  title: string;
  depth: number;
  via: string[];
  screenshot: string;
  aria: string;
  dom?: string;
  styled?: string;
  /** Part des pixels identiques entre l'écran original et son snapshot stylé rendu sans JS. */
  captureFidelity?: number;
  elements?: number;
}

interface Edge { from: string; to: string; action: string; calls: string[] }

interface Endpoint {
  method: string;
  template: string;
  statuses: Record<number, number>;
  calls: number;
  request: Shape;
  response: Shape;
  example?: unknown;
  requestFormat?: string;
  /** Réponses d'erreur observées : ce sont des règles métier déduites de l'extérieur. */
  errors: { status: number; request: unknown; response: unknown }[];
}

const CLICKABLE = ['link', 'button', 'checkbox', 'tab', 'menuitem', 'switch', 'radio'];

export const describeAction = (a: Action) =>
  a.kind === 'escape'
    ? 'Échap (fermer la modale)'
    : `${a.kind === 'fill-submit' ? 'remplir+Entrée' : 'clic'} ${a.role} "${a.name}"${a.nth ? ` #${a.nth + 1}` : ''}${a.inDialog ? ' (modale)' : ''}`;

/**
 * Si une boîte de dialogue est ouverte, seules ses lignes sont interactives : une modale
 * recouvre la page, et cliquer derrière échoue (timeout) ou n'a pas de sens.
 */
function dialogScope(lines: string[]): string[] | undefined {
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*- '?(dialog|alertdialog)\b/.test(lines[i])) start = i; // la dernière = la plus haute
  if (start === -1) return undefined;
  const indent = lines[start].match(/^\s*/)![0];
  const end = lines.findIndex((l, i) => i > start && !l.startsWith(indent + '  '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Extrait les actions possibles depuis le snapshot d'accessibilité. */
function discoverActions(aria: string, origin: string, opts: CrawlOptions): Action[] {
  const dialog = dialogScope(aria.split('\n'));
  const lines = dialog ?? aria.split('\n');
  const inDialog = dialog ? true : undefined;
  const counts = new Map<string, number>();
  const actions: Action[] = dialog ? [{ kind: 'escape', role: 'dialog', name: '', nth: 0 }] : [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)- (\w+) "([^"]*)"/);
    if (!m) return;
    const [, indent, role, name] = m;
    const key = `${role}|${name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    if (!name || opts.denyPattern.test(name)) return;
    if (role === 'textbox' || role === 'searchbox') {
      actions.push({ kind: 'fill-submit', role, name, nth, inDialog });
      return;
    }
    if (!CLICKABLE.includes(role)) return;
    if (role === 'link') {
      // on ne suit pas les liens externes
      const child = lines.slice(i + 1).find((l) => !l.startsWith(indent + '  ') || /\/url:/.test(l));
      const url = child?.match(/\/url: (\S+)/)?.[1];
      if (url && /^https?:/.test(url) && new URL(url).origin !== origin) return;
    }
    actions.push({ kind: 'click', role, name, nth, inDialog });
  });
  return actions.slice(0, opts.maxActionsPerState);
}

async function perform(page: Page, a: Action, probeText: string): Promise<void> {
  if (a.kind === 'escape') return page.keyboard.press('Escape');
  const root = a.inDialog ? page.getByRole('dialog').or(page.getByRole('alertdialog')).last() : page;
  const loc = root.getByRole(a.role as Parameters<Page['getByRole']>[0], { name: a.name, exact: true }).nth(a.nth);
  if (a.kind === 'fill-submit') {
    await loc.fill(probeText, { timeout: 5000 });
    await loc.press('Enter');
  } else {
    await activate(loc, 'click');
  }
}

export async function crawl(opts: CrawlOptions) {
  const origin = new URL(opts.url).origin;
  await mkdir(join(opts.out, 'screens'), { recursive: true });
  await mkdir(join(opts.out, 'aria'), { recursive: true });

  const browser = await launch();
  const states: StateRecord[] = [];
  const edges: Edge[] = [];
  const bySignature = new Map<string, string>();
  const endpoints = new Map<string, Endpoint>();
  const queue: QueueItem[] = [{ path: [] }];
  let replays = 0;
  const assets = new AssetCollector(opts.out, origin);
  const tokens: TokenCounts = {};

  const catalog = (calls: ApiCall[]) => {
    for (const c of calls) {
      if (new URL(c.url).origin !== origin) continue;
      // GET non JSON = scripts, pages, images… ; une écriture reste un endpoint même sans corps de réponse (ex. DELETE → 204)
      if (c.method === 'GET' && !c.contentType?.includes('json') && c.status < 400) continue;
      const key = `${c.method} ${c.template}`;
      const ep = endpoints.get(key) ?? {
        method: c.method, template: c.template, statuses: {}, calls: 0, request: emptyShape(), response: emptyShape(), errors: [],
      };
      ep.calls++;
      ep.statuses[c.status] = (ep.statuses[c.status] ?? 0) + 1;
      if (c.requestBody !== undefined) observe(ep.request, c.requestBody);
      ep.requestFormat ??= c.requestFormat;
      if (c.status >= 400) {
        const err = { status: c.status, request: c.requestBody, response: c.responseBody };
        const key = JSON.stringify(err);
        if (ep.errors.length < 5 && !ep.errors.some((e) => JSON.stringify(e) === key)) ep.errors.push(err);
      } else if (c.responseBody !== undefined && typeof c.responseBody === 'object') {
        observe(ep.response, c.responseBody);
        ep.example ??= normalizeJson(c.responseBody);
      }
      endpoints.set(key, ep);
    }
  };

  while (queue.length && states.length < opts.maxStates) {
    const item = queue.shift()!;
    const context = await newContext(browser, opts.storageState);
    const page = await context.newPage();
    const net = new NetworkRecorder(page);
    if (opts.rich) assets.attach(page);
    replays++;
    try {
      await resetTarget(opts.url, opts.resetPath, opts.resetCmd);
      await page.goto(opts.url);
      await settle(page);
      for (const a of item.path.slice(0, -1)) {
        await perform(page, a, opts.probeText);
        await settle(page);
      }
      catalog(await net.flush());

      const last = item.path.at(-1);
      if (last) {
        await perform(page, last, opts.probeText);
        await settle(page);
      }
      const edgeCalls = await net.flush();
      catalog(edgeCalls);

      const url = page.url();
      if (new URL(url).origin !== origin) continue;
      const aria = await page.locator('body').ariaSnapshot();
      const signature = templateUrl(url) + '\n' + structuralSignature(aria);

      let id = bySignature.get(signature);
      const isNew = !id;
      if (!id) {
        id = `s${states.length}`;
        bySignature.set(signature, id);
        await page.screenshot({ path: join(opts.out, 'screens', `${id}.png`) });
        await writeFile(join(opts.out, 'aria', `${id}.yaml`), aria);
        const state: StateRecord = {
          id, url, template: templateUrl(url), title: await page.title(), depth: item.path.length,
          via: item.path.map(describeAction), screenshot: `screens/${id}.png`, aria: `aria/${id}.yaml`,
        };
        if (opts.rich) {
          const rich = await captureRich(page, opts.out, id);
          mergeTokens(tokens, rich.tokens);
          await mkdir(join(opts.out, 'fidelity'), { recursive: true });
          const fidelity = await captureFidelity(context, origin, join(opts.out, rich.styled), join(opts.out, state.screenshot), join(opts.out, 'fidelity', `${id}.png`));
          Object.assign(state, { dom: rich.dom, styled: rich.styled, elements: rich.elements, captureFidelity: +fidelity.toFixed(4) });
        }
        states.push(state);
        process.stdout.write(`  + ${id} ${templateUrl(url)} (profondeur ${item.path.length})${state.captureFidelity !== undefined ? ` · snapshot stylé ${(state.captureFidelity * 100).toFixed(1)} % fidèle` : ''}\n`);
      }
      if (item.parentId && last) {
        edges.push({
          from: item.parentId, to: id, action: describeAction(last),
          calls: edgeCalls.map((c) => `${c.method} ${c.template} → ${c.status}`),
        });
      }
      if (isNew && item.path.length < opts.maxDepth) {
        for (const a of discoverActions(aria, origin, opts)) queue.push({ path: [...item.path, a], parentId: id });
      }
    } catch (err) {
      const where = item.path.map(describeAction).join(' → ') || 'page initiale';
      process.stdout.write(`  ! échec sur ${where}: ${(err as Error).message.split('\n')[0]}\n`);
    } finally {
      await assets.flush();
      await context.close();
    }
  }
  if (opts.scenarios) {
    for (const f of (await readdir(opts.scenarios)).filter((x) => x.endsWith('.json')).sort()) {
      const sc: Scenario = JSON.parse(await readFile(join(opts.scenarios, f), 'utf8'));
      const obs = await runScenario(browser, opts.url, sc, join(opts.out, 'scenarios', f.replace(/\.json$/, '')), { resetPath: opts.resetPath, resetCmd: opts.resetCmd, storageState: opts.storageState });
      const calls = obs.flatMap((o) => o.calls);
      catalog(calls);
      replays++;
      process.stdout.write(`  ▸ scénario « ${sc.name} » : ${calls.length} appels${obs.some((o) => o.error) ? ' (interrompu)' : ''}\n`);
    }
  }
  await browser.close();
  if (opts.rich) {
    const t = renderTokens(tokens);
    await writeFile(join(opts.out, 'design-tokens.json'), JSON.stringify(t.json, null, 2));
    await writeFile(join(opts.out, 'tokens.css'), t.css);
    await writeFile(join(opts.out, 'assets.json'), JSON.stringify([...assets.manifest.values()], null, 2));
  }

  // Regroupement par entité → schémas + brouillon Prisma
  const entities = new Map<string, Shape>();
  for (const ep of endpoints.values()) {
    const name = entityFromTemplate(ep.template);
    const shape = entityShape(ep.response);
    if (name && shape) entities.set(name, mergeInto(entities.get(name) ?? emptyShape(), shape));
  }

  const endpointList = [...endpoints.values()]
    .sort((a, b) => a.template.localeCompare(b.template) || a.method.localeCompare(b.method))
    .map((ep) => ({
      method: ep.method, template: ep.template, calls: ep.calls, statuses: ep.statuses,
      entity: entities.has(entityFromTemplate(ep.template) ?? '') ? entityFromTemplate(ep.template) : undefined,
      requestFormat: ep.requestFormat,
      requestSchema: ep.request.seen ? toJsonSchema(ep.request) : undefined,
      responseSchema: ep.response.seen ? toJsonSchema(ep.response) : undefined,
      example: ep.example,
      errors: ep.errors,
    }));

  const prisma = toPrisma(entities);
  const mermaid = ['graph LR', ...states.map((s) => `  ${s.id}["${s.id} ${s.template}"]`),
    ...edges.filter((e) => e.from !== e.to).map((e) => `  ${e.from} -->|"${e.action.replace(/"/g, "'")}"| ${e.to}`)].join('\n');

  await writeFile(join(opts.out, 'states.json'), JSON.stringify({ states, edges }, null, 2));
  await writeFile(join(opts.out, 'endpoints.json'), JSON.stringify(endpointList, null, 2));
  await writeFile(join(opts.out, 'API.md'), apiReference(opts.url, endpointList));
  await writeFile(join(opts.out, 'entities.json'), JSON.stringify(Object.fromEntries([...entities].map(([k, v]) => [k, toJsonSchema(v)])), null, 2));
  await writeFile(join(opts.out, 'schema.prisma'), prisma);
  await writeFile(join(opts.out, 'graph.mmd'), mermaid);
  await writeFile(join(opts.out, 'SUMMARY.md'), summary(opts, states, edges, endpointList, prisma, mermaid, replays, [...assets.manifest.values()]));

  return { states, edges, endpoints: endpointList, entities: [...entities.keys()], replays };
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; format?: string; enum?: unknown[] };

/** Schéma JSON → lignes « champ: type » indentées (2 niveaux d'objets imbriqués, listes déballées). */
function fieldLines(s: JsonSchema | undefined, depth = 0, prefix = ''): string[] {
  if (!s) return [];
  if (s.items && !s.properties) return fieldLines(s.items, depth, prefix + '[]');
  const lines: string[] = [];
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const t = [v.type].flat().filter(Boolean).join(' | ') + (v.items ? (v.items.properties ? ' of object' : [v.items.type].flat().filter(Boolean).length ? ` of ${[v.items.type].flat().join(' | ')}` : ' (toujours vide dans le trafic observé)') : '');
    const extra = [v.format, v.enum && `enum: ${v.enum.map((x) => JSON.stringify(x)).join(', ')}`, !s.required?.includes(k) && 'optionnel'].filter(Boolean).join(', ');
    lines.push(`${'  '.repeat(depth)}- \`${prefix}${k}\`: ${t}${extra ? ` (${extra})` : ''}`);
    const child = v.properties ? v : v.items?.properties ? v.items : undefined;
    if (child && depth < 2) lines.push(...fieldLines(child, depth + 1));
  }
  return lines;
}

/** Référence d'API lisible (humain ou bot) : ce que chaque route demande et renvoie, déduit du trafic observé. */
function apiReference(url: string, endpoints: { method: string; template: string; statuses: Record<number, number>; calls: number; requestFormat?: string; requestSchema?: unknown; responseSchema?: unknown; errors: Endpoint['errors'] }[]): string {
  const short = (v: unknown) => { const s = JSON.stringify(v) ?? '—'; return s.length > 200 ? s.slice(0, 197) + '…' : s; };
  const section = (e: (typeof endpoints)[number]) => {
    const req = fieldLines(e.requestSchema as JsonSchema);
    const res = fieldLines(e.responseSchema as JsonSchema);
    const rt = (e.responseSchema as JsonSchema | undefined)?.type;
    return `### \`${e.method} ${e.template}\`

Statuts observés : ${Object.entries(e.statuses).map(([s, n]) => `${s} (×${n})`).join(', ')}

**Corps envoyé**${e.requestFormat ? ` (format \`${e.requestFormat}\`, converti en champs)` : ''} :
${req.length ? req.join('\n') : '_aucun_'}

**Réponse**${rt ? ` (\`${[rt].flat().join(' | ')}\`)` : ''} :
${res.length ? res.join('\n') : '_non JSON ou vide_'}
${e.errors.length ? `\n**Erreurs observées** :\n${e.errors.map((x) => `- **${x.status}** avec \`${short(x.request)}\` → \`${short(x.response)}\``).join('\n')}\n` : ''}`;
  };
  return `# Référence d'API déduite — ${url}

Déduite du trafic observé pendant l'exploration (aucun accès au code ni à une documentation). Les ids sont remplacés par \`:id\` ; « optionnel » = champ absent d'au moins une réponse observée.

| Méthode | Route | Statuts | Appels |
|---|---|---|---|
${endpoints.map((e) => `| ${e.method} | \`${e.template}\` | ${Object.keys(e.statuses).join(', ')} | ${e.calls} |`).join('\n')}

${endpoints.map(section).join('\n---\n\n')}`;
}

function errorLines(endpoints: { method: string; template: string; errors: Endpoint['errors'] }[], keep: (status: number) => boolean): string {
  const short = (v: unknown) => { const s = JSON.stringify(v) ?? '—'; return s.length > 160 ? s.slice(0, 157) + '…' : s; };
  return endpoints
    .flatMap((e) => e.errors.filter((x) => keep(x.status)).map((x) => `- \`${e.method} ${e.template}\` avec \`${short(x.request)}\` → **${x.status}** \`${short(x.response)}\``))
    .join('\n');
}

function summary(
  opts: CrawlOptions, states: StateRecord[], edges: Edge[],
  endpoints: { method: string; template: string; calls: number; statuses: Record<number, number>; entity?: string; errors: Endpoint['errors'] }[],
  prisma: string, mermaid: string, replays: number, assets: { type: string; bytes: number }[],
): string {
  const fid = states.filter((s) => s.captureFidelity !== undefined);
  const byType = Object.entries(assets.reduce<Record<string, [number, number]>>((acc, a) => { const x = (acc[a.type] ??= [0, 0]); x[0]++; x[1] += a.bytes; return acc; }, {}));
  return `# Capture — ${opts.url}

- **${states.length} états** distincts, **${edges.length} transitions**, **${endpoints.length} endpoints**, ${replays} rejeux depuis un état réinitialisé
- Profondeur max ${opts.maxDepth}, reset : ${opts.resetPath ?? 'aucun'}

## Graphe d'états

\`\`\`mermaid
${mermaid}
\`\`\`

## États

| id | route | atteint via |
|---|---|---|
${states.map((s) => `| ${s.id} | \`${s.template}\` | ${s.via.join(' → ') || '(entrée)'} |`).join('\n')}

${fid.length ? `## Capture du front

Pour chaque état : DOM vivant (\`dom/\`), snapshot autonome aux styles calculés inlinés (\`styled/\`), tokens de design (\`design-tokens.json\`, \`tokens.css\`) et ressources (\`assets/\`, \`assets.json\`).

- **Fidélité des snapshots stylés** (rendus sans le JS de l'app, comparés pixel à pixel à l'original) : moyenne **${((fid.reduce((a, s) => a + s.captureFidelity!, 0) / fid.length) * 100).toFixed(1)} %**, min ${(Math.min(...fid.map((s) => s.captureFidelity!)) * 100).toFixed(1)} %
- Ressources : ${byType.map(([t, [n, b]]) => `${n} ${t} (${(b / 1024).toFixed(0)} Ko)`).join(', ') || 'aucune'}

| état | éléments | fidélité |
|---|---|---|
${fid.map((s) => `| ${s.id} \`${s.template}\` | ${s.elements} | ${(s.captureFidelity! * 100).toFixed(1)} % |`).join('\n')}

` : ''}## Endpoints

| méthode | route | entité | statuts observés | appels |
|---|---|---|---|---|
${endpoints.map((e) => `| ${e.method} | \`${e.template}\` | ${e.entity ?? ''} | ${Object.entries(e.statuses).map(([s, n]) => `${s}×${n}`).join(', ')} | ${e.calls} |`).join('\n')}

## Règles métier observées (réponses d'erreur)

${errorLines(endpoints, (s) => s !== 401 && s !== 403) || '_Aucune erreur métier provoquée pendant l’exploration._'}

## Authentification / droits observés (401, 403)

${errorLines(endpoints, (s) => s === 401 || s === 403) || '_Aucun._'}

## Modèle de données déduit (brouillon)

\`\`\`prisma
${prisma}\`\`\`
`;
}
