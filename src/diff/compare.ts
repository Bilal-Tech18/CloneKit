// Comparaison original ↔ clone, étape par étape, sur 5 canaux :
// action (l'étape a-t-elle pu s'exécuter), url, api, aria (ce qu'un agent "lit"), visuel (ce qu'il "voit").
import { readFile, writeFile } from 'node:fs/promises';
import { diffArrays, diffWords } from 'diff';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { ApiCall } from '../shared/browser.js';
import { normalizeAria, normalizeJson } from '../shared/normalize.js';
import type { Observation, Scenario } from './scenario.js';

export type Channel = 'action' | 'url' | 'api' | 'aria' | 'visual';
export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  channel: Channel;
  severity: Severity;
  title: string;
  detail: string[];
  /** Clé de dédoublonnage : un même écart vu à plusieurs étapes = un seul ticket. */
  signature: string;
  /** Clé de bruit plus large (ex. « cette ligne d'écran est instable », quel que soit son nouveau texte). */
  noiseKey?: string;
  scenario: string;
  step: number;
  stepLabel: string;
}

export interface StepResult {
  step: number;
  label: string;
  checks: Record<Channel, boolean | null>;
  original?: Observation;
  clone?: Observation;
  ariaDiff?: string[];
  apiDiff?: string[];
  visual?: { ratio: number; diffImage?: string };
}

export interface ScenarioResult {
  scenario: Scenario;
  steps: StepResult[];
  findings: Finding[];
  /** Écarts ignorés car l'original produit les mêmes en se comparant à lui-même (calibration). */
  suppressed: Finding[];
  passed: number;
  total: number;
  /** Mesures continues (0..1), utiles quand le binaire réussi/échoué est trop grossier (ex. front régénéré). */
  similarity: { visual: number; aria: number };
}

const VISUAL_MIN_PIXELS = 20; // en dessous : bruit d'anticrénelage

// ---------- JSON ----------

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '…' : s;
};

/** Diff structurel lisible : clés manquantes, types, valeurs, longueur et ordre des listes. */
export function jsonDiff(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (kind(a) !== kind(b)) {
    out.push(`${path}: type ${kind(a)} dans l'original, ${kind(b)} dans le clone`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: ${a.length} éléments dans l'original, ${b.length} dans le clone`);
    let bb = b;
    const reordered = sameItemsDifferentOrder(a, b);
    if (reordered) {
      out.push(`${path}: mêmes éléments mais ordre différent (tri non reproduit)`);
      bb = reordered;
    }
    for (let i = 0; i < Math.min(a.length, bb.length); i++) jsonDiff(a[i], bb[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of Object.keys(ao)) {
      if (!(k in bo)) out.push(`${path}.${k}: absent du clone (original : ${show(ao[k])})`);
      else jsonDiff(ao[k], bo[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(bo)) if (!(k in ao)) out.push(`${path}.${k}: présent uniquement dans le clone`);
    return out;
  }
  if (a !== b) out.push(`${path}: original ${show(a)} ≠ clone ${show(b)}`);
  return out;
}

/** Si b est une permutation de a (comparée sur les clés communes), renvoie b remis dans l'ordre de a. */
function sameItemsDifferentOrder(a: unknown[], b: unknown[]): unknown[] | undefined {
  if (a.length !== b.length || a.length < 2) return undefined;
  const common = (x: unknown, y: unknown) =>
    x && y && typeof x === 'object' && typeof y === 'object'
      ? Object.keys(x).filter((k) => k in (y as object))
      : null;
  const keys = common(a[0], b[0]);
  const project = (v: unknown) =>
    keys ? JSON.stringify(Object.fromEntries(keys.map((k) => [k, (v as Record<string, unknown>)[k]]))) : JSON.stringify(v);
  const pa = a.map(project);
  const pb = b.map(project);
  if (pa.every((p, i) => p === pb[i])) return undefined;
  const pool = pb.map((p, i) => ({ p, v: b[i], used: false }));
  const out: unknown[] = [];
  for (const p of pa) {
    const hit = pool.find((x) => !x.used && x.p === p);
    if (!hit) return undefined;
    hit.used = true;
    out.push(hit.v);
  }
  return out;
}

const generalize = (line: string) => line.replace(/\[\d+\]/g, '[*]').replace(/\(original : .*\)$/, '').replace(/original .* ≠ clone .*/, 'valeur différente');

type Emit = (f: Omit<Finding, 'scenario' | 'step' | 'stepLabel'>) => boolean;
const originOf = (url: string) => new URL(url).origin;

// /api/v2/tasks/:id → /api/v{n}/tasks/:id : pour apparier deux versions d'une même API.
const versionless = (t: string) => t.replace(/\/v\d+(?=\/|$)/, '/v{n}');
const versionOf = (t: string) => t.match(/\/v\d+(?=\/|$)/)?.[0] ?? '';
const isJson = (c: ApiCall) => !!c.contentType?.includes('json');

/**
 * Appariement en deux passes : d'abord à l'identique (méthode + route), puis pour les restes
 * « même route à la version près » et « même route, autre méthode ». Un changement de préfixe
 * d'API donne ainsi UN écart, et les corps de réponse restent comparés.
 */
function compareApi(orig: ApiCall[], clone: ApiCall[], ignoreKeys: string[] | undefined, emit: Emit): string[] {
  const lines: string[] = [];
  const remaining = [...clone];
  const pairs: { o: ApiCall; c?: ApiCall }[] = orig.map((o) => {
    const idx = remaining.findIndex((c) => c.method === o.method && c.template === o.template);
    return { o, c: idx === -1 ? undefined : remaining.splice(idx, 1)[0] };
  });
  for (const p of pairs.filter((x) => !x.c)) {
    let idx = remaining.findIndex((c) => c.method === p.o.method && versionless(c.template) === versionless(p.o.template));
    if (idx === -1) idx = remaining.findIndex((c) => versionless(c.template) === versionless(p.o.template));
    if (idx !== -1) p.c = remaining.splice(idx, 1)[0];
  }

  for (const { o, c } of pairs) {
    const route = `${o.method} ${o.template}`;
    if (!c) {
      if (emit({ channel: 'api', severity: 'high', title: `${route} n'est jamais appelé par le clone`, detail: [`Original : ${o.status}`], signature: `api-missing|${route}` })) {
        lines.push(`${route}: appel absent du clone`);
      }
      continue;
    }
    if (versionOf(o.template) !== versionOf(c.template)) {
      const sig = `api-version|${versionOf(o.template)}|${versionOf(c.template)}`;
      if (emit({ channel: 'api', severity: 'high', title: `Version d'API différente : l'original appelle ${versionOf(o.template)}, le clone ${versionOf(c.template)}`, detail: [`ex. ${route} ↔ ${c.method} ${c.template}`], signature: sig })) {
        lines.push(`${route}: appelé en ${versionOf(c.template)} par le clone`);
      }
    }
    if (o.method !== c.method) {
      const vr = `${versionless(o.template)}`;
      if (emit({ channel: 'api', severity: 'high', title: `Méthode HTTP différente sur ${vr} : ${o.method} dans l'original, ${c.method} dans le clone`, detail: [`${route} ↔ ${c.method} ${c.template}`], signature: `api-method|${vr}|${o.method}|${c.method}` })) {
        lines.push(`${route}: méthode ${c.method} dans le clone`);
      }
    }
    if (o.status !== c.status) {
      const kept = emit({
        channel: 'api', severity: 'high', title: `${route} : statut ${o.status} attendu, ${c.status} obtenu`,
        detail: [`Requête : ${show(o.requestBody) ?? '—'}`, `Réponse originale : ${show(o.responseBody) ?? '—'}`, `Réponse clone : ${show(c.responseBody) ?? '—'}`],
        signature: `api-status|${versionless(route)}|${o.status}|${c.status}`,
      });
      if (kept) lines.push(`${route}: statut ${o.status} (original) ≠ ${c.status} (clone)`);
      continue; // le corps diffère forcément, inutile de le détailler
    }
    if (!isJson(o) || !isJson(c)) continue; // scripts, images… : seul le statut est comparé
    const diffs = jsonDiff(
      normalizeJson(o.responseBody, { ignoreKeys, origin: originOf(o.url) }),
      normalizeJson(c.responseBody, { ignoreKeys, origin: originOf(c.url) }),
    );
    for (const g of new Set(diffs.map(generalize))) {
      const group = diffs.filter((x) => generalize(x) === g);
      const r = `${o.method} ${versionless(o.template)}`;
      const kept = emit({ channel: 'api', severity: 'high', title: `${r} — ${g}`, detail: group.slice(0, 5), signature: `api-body|${r}|${g}` });
      if (kept) lines.push(...group.map((d) => `${route} ${d}`));
    }
  }
  for (const c of remaining) {
    const route = `${c.method} ${c.template}`;
    if (emit({ channel: 'api', severity: 'medium', title: `${route} appelé par le clone mais pas par l'original`, detail: [`Statut clone : ${c.status}`], signature: `api-extra|${route}` })) {
      lines.push(`${route}: appel supplémentaire côté clone`);
    }
  }
  return lines;
}

// ---------- Aria ----------

interface AriaChange { kind: 'changed' | 'missing' | 'extra' | 'order'; from?: string; to?: string }

const ariaLines = (aria: string, origin?: string) => normalizeAria(aria, origin).split('\n').map((l) => l.trim()).filter(Boolean);

/** Similarité 0..1 entre deux lignes (part de caractères communs au niveau des mots). */
function similarity(x: string, y: string): number {
  const common = diffWords(x, y).filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
  return common / Math.max(x.length, y.length, 1);
}

/**
 * Diff de l'arbre d'accessibilité. Les lignes inchangées sont alignées (LCS), puis les lignes
 * restantes sont appariées : identiques = déplacées, proches = modifiées, sinon absentes / en trop.
 * Si les appariements ne respectent plus l'ordre de l'original → écart d'ordre.
 */
function compareAria(a: string, b: string, originA?: string, originB?: string): { display: string[]; changes: AriaChange[]; similarity: number } {
  const la = ariaLines(a, originA);
  const lb = ariaLines(b, originB);
  const display: string[] = [];
  const removed: { line: string; i: number }[] = [];
  const added: { line: string; j: number }[] = [];
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  for (const part of diffArrays(la, lb)) {
    for (const line of part.value) {
      if (part.removed) { removed.push({ line, i: i++ }); display.push(`- original ${line}`); }
      else if (part.added) { added.push({ line, j: j++ }); display.push(`+ clone    ${line}`); }
      else pairs.push([i++, j++]);
    }
  }
  const changes: AriaChange[] = [];
  const free = new Set(added);
  const take = (r: { line: string; i: number }, match: (x: { line: string; j: number }) => boolean) => {
    const hit = [...free].find(match);
    if (hit) { free.delete(hit); pairs.push([r.i, hit.j]); }
    return hit;
  };
  const pending = removed.filter((r) => !take(r, (x) => x.line === r.line)); // déplacées
  const identical = pairs.length;
  for (const r of pending) {
    const best = [...free].map((x) => ({ x, s: similarity(r.line, x.line) })).sort((p, q) => q.s - p.s)[0];
    if (best && best.s >= 0.5) {
      take(r, (x) => x === best.x);
      changes.push({ kind: 'changed', from: r.line, to: best.x.line });
    } else changes.push({ kind: 'missing', from: r.line });
  }
  for (const x of free) changes.push({ kind: 'extra', to: x.line });
  const order = pairs.sort((p, q) => p[0] - q[0]).some(([, jj], k, arr) => k > 0 && jj < arr[k - 1][1]);
  if (order) changes.unshift({ kind: 'order' });
  return { display, changes, similarity: identical / Math.max(la.length, lb.length, 1) };
}

const role = (line = '') => line.match(/^- '?(\w+)/)?.[1] ?? 'texte';
/** "text: Fix crash @tom high" → "text: Fix crash high" ⇒ forme "text|-@w|+" : regroupe les variantes d'un même écart. */
function changeShape(c: AriaChange): string {
  if (c.kind !== 'changed') return `${c.kind}|${c.from ?? c.to}`;
  const mask = (x: string) => x.trim().replace(/[\p{L}\p{N}]+/gu, 'w');
  const parts = diffWords(c.from!, c.to!);
  const rem = parts.filter((p) => p.removed).map((p) => mask(p.value)).join(' ');
  const add = parts.filter((p) => p.added).map((p) => mask(p.value)).join(' ');
  return `changed|${role(c.from)}|-${rem}|+${add}`;
}

// ---------- Visuel ----------

async function compareImages(a: string, b: string, diffPath: string): Promise<{ ratio: number; pixels: number }> {
  const [ia, ib] = await Promise.all([readFile(a), readFile(b)]).then((bufs) => bufs.map((x) => PNG.sync.read(x)));
  if (ia.width !== ib.width || ia.height !== ib.height) return { ratio: 1, pixels: Infinity };
  const diff = new PNG({ width: ia.width, height: ia.height });
  const n = pixelmatch(ia.data, ib.data, diff.data, ia.width, ia.height, { threshold: 0.05 });
  if (n > 0) await writeFile(diffPath, PNG.sync.write(diff));
  return { ratio: n / (ia.width * ia.height), pixels: n };
}

// ---------- Orchestration ----------

/**
 * @param noise signatures d'écarts que l'original produit contre lui-même (calibration) : ignorées.
 */
export async function compareScenario(
  scenario: Scenario, orig: Observation[], clone: Observation[], outDir: string, noise: Set<string> = new Set(),
  /** Canaux évalués (défaut : tous). Ex. sans `api` pour un front régénéré branché sur le même back. */
  channels: ReadonlySet<Channel> = new Set(['action', 'url', 'api', 'aria', 'visual']),
): Promise<ScenarioResult> {
  const sims = { visual: [] as number[], aria: [] as number[] };
  const findings: Finding[] = [];
  const suppressed: Finding[] = [];
  const steps: StepResult[] = [];
  let passed = 0;
  let total = 0;

  for (let i = 0; i < scenario.steps.length; i++) {
    const o = orig[i];
    const c = clone[i];
    const label = o?.label ?? c?.label ?? `étape ${i}`;
    const failed = new Set<Channel>();
    const emit: Emit = (f) => {
      const full = { ...f, scenario: scenario.name, step: i, stepLabel: label };
      if (!channels.has(f.channel)) return false;
      if (noise.has(f.signature) || (f.noiseKey && noise.has(f.noiseKey))) { suppressed.push(full); return false; }
      findings.push(full);
      failed.add(f.channel);
      return true;
    };
    const res: StepResult = { step: i, label, original: o, clone: c, checks: { action: null, url: null, api: null, aria: null, visual: null } };
    steps.push(res);
    if (!o && !c) break;

    // action
    const actionOk = !!o && !!c && !c.error && !o.error;
    res.checks.action = actionOk;
    if (o?.error && c?.error) {
      // même échec des deux côtés : c'est le scénario qui est faux, pas le clone → hors score
      res.checks.action = null;
      emit({ channel: 'action', severity: 'low', title: `Scénario à corriger : « ${label} » impossible sur l'original comme sur le clone`, detail: [o.error], signature: `action-both|${scenario.name}|${i}` });
      failed.delete('action');
    } else if (o?.error && !c?.error) {
      emit({ channel: 'action', severity: 'medium', title: `Étape impossible sur l'original (scénario à corriger)`, detail: [o.error], signature: `action-orig|${scenario.name}|${i}` });
    } else if (c?.error && !o?.error) {
      emit({ channel: 'action', severity: 'high', title: `Étape « ${label} » impossible dans le clone`, detail: [c.error], signature: `action|${scenario.name}|${i}` });
    }
    if (!o || !c) { total += 1; break; }

    if (o.template !== c.template) emit({ channel: 'url', severity: 'high', title: `Route différente : ${o.template} → ${c.template}`, detail: [], signature: `url|${o.template}|${c.template}` });

    res.apiDiff = compareApi(o.calls, c.calls, scenario.ignoreKeys, emit);

    const aria = compareAria(o.aria, c.aria, originOf(o.url), originOf(c.url));
    if (aria.changes.some((ch) => ch.kind === 'order')) {
      emit({ channel: 'aria', severity: 'medium', title: `Ordre des éléments différent à l'écran (${o.template})`, detail: aria.display.slice(0, 14), signature: `aria-order|${o.template}` });
    }
    for (const ch of aria.changes.filter((x) => x.kind === 'changed')) {
      emit({ channel: 'aria', severity: 'medium', title: `À l'écran : « ${ch.from} » devient « ${ch.to} »`, detail: [`- original ${ch.from}`, `+ clone    ${ch.to}`], signature: `aria|${changeShape(ch)}`, noiseKey: `aria-line|${ch.from}` });
    }
    // lignes absentes / en trop d'une même étape = généralement un seul élément d'UI → un seul écart
    for (const kind of ['missing', 'extra'] as const) {
      const lines = aria.changes.filter((x) => x.kind === kind).map((x) => (x.from ?? x.to)!);
      if (!lines.length) continue;
      emit({
        channel: 'aria', severity: 'medium',
        title: kind === 'missing' ? `${lines.length} élément(s) absent(s) de l'écran du clone après « ${label} »` : `${lines.length} élément(s) en trop sur l'écran du clone après « ${label} »`,
        detail: lines.slice(0, 10).map((l) => `${kind === 'missing' ? '- original' : '+ clone   '} ${l}`),
        signature: `aria-${kind}|${lines.map((l) => role(l) + ':' + l.replace(/"[^"]*"/g, '""')).sort().join('|')}`,
      });
    }

    res.ariaDiff = failed.has('aria') ? aria.display : [];
    sims.aria.push(aria.similarity);

    const diffImage = `${outDir}/visual-${i}.png`;
    const { ratio, pixels } = await compareImages(o.screenshot, c.screenshot, diffImage);
    res.visual = { ratio, diffImage: pixels > 0 ? diffImage : undefined };
    sims.visual.push(1 - ratio);
    if (pixels >= VISUAL_MIN_PIXELS) {
      const share = `${pixels} pixels (${(ratio * 100).toFixed(2)} %)`;
      // structure identique mais pixels différents → vrai écart de style, sinon simple conséquence
      if (!failed.has('aria')) {
        emit({ channel: 'visual', severity: 'medium', title: `Écart purement visuel (CSS) sur ${o.template}`, detail: [`${share} — voir l'image de diff de l'étape « ${label} »`], signature: `visual-css|${o.template}` });
      } else {
        emit({ channel: 'visual', severity: 'low', title: `Rendus différents, conséquence des écarts de structure ci-dessus`, detail: [], signature: 'visual-structural' });
      }
    }

    for (const ch of ['url', 'api', 'aria', 'visual'] as const) res.checks[ch] = !failed.has(ch);
    for (const ch of Object.keys(res.checks) as Channel[]) if (!channels.has(ch)) res.checks[ch] = null;
    for (const ok of Object.values(res.checks)) if (ok !== null) { total++; if (ok) passed++; }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 1);
  return { scenario, steps, findings, suppressed, passed, total, similarity: { visual: mean(sims.visual), aria: mean(sims.aria) } };
}
