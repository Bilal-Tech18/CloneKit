// Normalisation : neutralise ce qui varie légitimement entre deux instances
// (ids, dates, ordre des clés) pour ne comparer que ce qui compte.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ID_KEY = /^(id|_id|uuid|.+Id|.+_id)$/;

export interface NormalizeOptions {
  /** Clés dont la valeur est ignorée (ex. timestamps, tokens). */
  ignoreKeys?: string[];
  /** Origine de l'instance (http://localhost:3456) : remplacée par <origin> dans les valeurs. */
  origin?: string;
}

/** Remplace l'URL / l'hôte propres à une instance : deux déploiements n'ont jamais la même adresse. */
export function stripOrigin(value: string, origin?: string): string {
  if (!origin) return value;
  const host = new URL(origin).host;
  return value.replaceAll(origin, '<origin>').replaceAll(host, '<host>');
}

const DEFAULT_IGNORED = ['createdAt', 'updatedAt', 'created_at', 'updated_at', 'lastSeenAt'];

function isIdSegment(seg: string): boolean {
  return (
    /^-?\d+$/.test(seg) ||
    UUID.test(seg) ||
    /^[0-9a-f]{16,}$/i.test(seg) ||
    // slugs techniques type "cmrtrg8k50001uc1s6e6uuyov" (cuid) ou "a1b2c3d4"
    (/^[a-z0-9_-]{8,}$/i.test(seg) && /\d/.test(seg) && /[a-z]/i.test(seg))
  );
}

/** /api/projects/42/tasks → /api/projects/:id/tasks */
export function templatePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (seg && isIdSegment(seg) ? ':id' : seg))
    .join('/');
}

export function templateUrl(url: string): string {
  const u = new URL(url);
  return templatePath(u.pathname);
}

/** Masque ids / dates et trie les clés ; l'ordre des tableaux est conservé (il est significatif). */
export function normalizeJson(value: unknown, opts: NormalizeOptions = {}, key = ''): unknown {
  const ignored = new Set([...DEFAULT_IGNORED, ...(opts.ignoreKeys ?? [])]);
  if (ignored.has(key)) return '<ignored>';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => normalizeJson(v, opts, ''));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = normalizeJson((value as Record<string, unknown>)[k], opts, k);
    }
    return out;
  }
  if (ID_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) return '<id>';
  if (typeof value === 'string') {
    value = stripOrigin(value, opts.origin);
    if (UUID.test(value as string)) return '<id>';
    if (ISO_DATE.test(value as string)) return '<date>';
  }
  return value;
}

/** Normalise un snapshot d'accessibilité Playwright (YAML) : ids dans les URLs, dates. */
export function normalizeAria(aria: string, origin?: string): string {
  return stripOrigin(aria, origin)
    .split('\n')
    .map((line) =>
      line
        .replace(/(\/url: )(\S+)/, (_, p, url) => p + templatePath(url))
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<date>'),
    )
    .join('\n');
}

/**
 * Signature structurelle d'un écran : rôles sans les textes, blocs répétés repliés.
 * Deux pages projet avec 1 ou 10 tâches ont la même signature → même "état".
 * Un message d'erreur affiché (alert non vide) donne en revanche un état distinct.
 */
export function structuralSignature(aria: string): string {
  const lines = aria
    .split('\n')
    .map((l) => l.replace(/^(\s*- )'(.*)'(:?)$/, '$1$2$3')) // lignes YAML entre quotes
    .map((l) => l.replace(/"[^"]*"/g, '""').replace(/\[[^\]]*\]/g, '').replace(/:\s.*$/, ':').trimEnd())
    .filter((l) => !/^\s*- (text|\/url|\/placeholder)/.test(l));
  // replie les blocs consécutifs identiques (une ligne de liste = souvent 2-5 éléments)
  const out: string[] = [];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (let i = 0; i < lines.length; ) {
    let k = 1;
    for (; k <= 6; k++) {
      if (out.length >= k && same(lines.slice(i, i + k), out.slice(-k))) break;
    }
    if (k <= 6) i += k;
    else out.push(lines[i++]);
  }
  return out.join('\n');
}
