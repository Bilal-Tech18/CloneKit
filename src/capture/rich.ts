// Capture « riche » d'un écran, pour RECONSTRUIRE le front (et non plus seulement le comparer) :
// - dom/<id>.html      : DOM vivant sérialisé (après exécution du JS)
// - styled/<id>.html   : snapshot autonome, styles calculés inlinés, scripts retirés — lisible par un LLM
//                        et affichable tel quel ; on le re-rend pour mesurer la fidélité de la capture
// - tokens             : couleurs, typos, rayons, ombres, espacements, comptés sur tous les écrans
// - ressources         : CSS, polices, images, scripts téléchargés par l'app (voir AssetCollector)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export type TokenCounts = Record<string, Record<string, number>>;

export interface RichResult {
  dom: string;
  styled: string;
  elements: number;
  bytes: number;
  tokens: TokenCounts;
}

/**
 * Exécuté dans la page. Pour chaque élément visible, on ne garde que les propriétés qui diffèrent
 * de la valeur par défaut de la balise (calculée dans une iframe vierge) ; pour les propriétés héritées,
 * seulement celles qui diffèrent du parent. Résultat : un HTML compact mais rendu à l'identique.
 */
function snapshotInPage(): { html: string; elements: number; tokens: Record<string, Record<string, number>> } {
  const PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear', 'box-sizing', 'overflow-x', 'overflow-y',
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'justify-content', 'align-items', 'align-self', 'align-content',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'gap', 'row-gap', 'column-gap',
    'min-width', 'max-width', 'min-height', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
    'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
    'box-shadow', 'opacity', 'transform', 'visibility', 'cursor', 'outline-style', 'object-fit', 'vertical-align',
    'text-decoration-line', 'text-decoration-color', 'text-overflow', 'fill', 'stroke',
  ];
  const INHERITED = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space', 'word-break', 'list-style-type'];
  // Les éléments remplacés ou absolus n'ont pas de taille « naturelle » : on fige leur boîte.
  const SIZED = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IFRAME']);
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'STYLE', 'BASE']);
  const ATTRS = /^(id|role|aria-.*|href|src|alt|title|type|name|placeholder|value|checked|disabled|for|tabindex|viewbox|d|fill|stroke|points|cx|cy|r|x|y|width|height|xmlns|data-icon|colspan|rowspan|open)$/i;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const blank = frame.contentDocument!;
  const defaults = new Map<string, CSSStyleDeclaration>();
  const defaultsOf = (el: Element) => {
    const key = el.namespaceURI + el.localName + (el.localName === 'a' && el.hasAttribute('href') ? '[href]' : '');
    if (!defaults.has(key)) {
      const ref = blank.createElementNS(el.namespaceURI, el.localName);
      if (el.localName === 'a' && el.hasAttribute('href')) ref.setAttribute('href', '#'); // style de lien par défaut
      (el.namespaceURI?.includes('svg') ? blank.body.appendChild(blank.createElementNS('http://www.w3.org/2000/svg', 'svg')) : blank.body).appendChild(ref);
      defaults.set(key, getComputedStyle(ref));
    }
    return defaults.get(key)!;
  };

  const plainRef = blank.createElement('div');
  blank.body.appendChild(plainRef);
  const plain = getComputedStyle(plainRef);
  const tokens: Record<string, Record<string, number>> = {};
  const count = (k: string, v: string) => {
    if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === '0px' || v === 'rgba(0, 0, 0, 0)') return;
    (tokens[k] ??= {})[v] = (tokens[k][v] ?? 0) + 1;
  };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
  let elements = 0;

  const walk = (el: Element, parent: CSSStyleDeclaration | null): string => {
    if (SKIP.has(el.tagName.toUpperCase()) || el === frame) return '';
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return '';
    elements++;
    const def = defaultsOf(el);
    const decl: string[] = [];
    for (const p of PROPS) {
      // couleur d'une bordure ou d'un soulignement inexistant : bruit
      const side = p.match(/^border-(\w+)-color$/)?.[1];
      if (side && cs.getPropertyValue(`border-${side}-style`) === 'none') continue;
      if (p === 'text-decoration-color' && cs.textDecorationLine === 'none') continue;
      const v = cs.getPropertyValue(p);
      if (v !== def.getPropertyValue(p)) decl.push(`${p}:${v}`);
    }
    for (const p of INHERITED) {
      const v = cs.getPropertyValue(p);
      // hérité du parent… sauf si la balise a son propre style navigateur (ex. couleur des liens)
      const uaOverride = def.getPropertyValue(p) !== plain.getPropertyValue(p);
      if (v !== (parent ? parent.getPropertyValue(p) : def.getPropertyValue(p)) || uaOverride) decl.push(`${p}:${v}`);
    }
    const r = el.getBoundingClientRect();
    // taille figée quand elle ne se déduit pas du contenu : éléments remplacés, positionnés, ou qui rognent leur contenu
    const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const empty = !el.textContent?.trim() && !el.querySelector('img,svg,input,textarea,select,canvas,video,iframe'); // espaceurs, pastilles…
    if (SIZED.has(el.tagName.toUpperCase()) || cs.position === 'absolute' || cs.position === 'fixed' || clips || (empty && r.width > 0)) decl.push(`width:${r.width}px`, `height:${r.height}px`);
    // tokens de design
    count('color', cs.color);
    count('background', cs.backgroundColor);
    if (cs.borderTopStyle !== 'none') count('border-color', cs.borderTopColor);
    count('font-family', cs.fontFamily);
    count('font-size', cs.fontSize);
    count('font-weight', cs.fontWeight);
    count('line-height', cs.lineHeight);
    count('radius', cs.borderTopLeftRadius);
    count('shadow', cs.boxShadow);
    for (const p of ['padding-top', 'padding-left', 'margin-top', 'margin-bottom', 'gap']) count('spacing', cs.getPropertyValue(p));

    const tag = el.localName;
    const attrs = [...el.attributes].filter((a) => ATTRS.test(a.name)).map((a) => {
      const v = (a.name === 'href' || a.name === 'src') && a.value && !a.value.startsWith('data:') ? new URL(a.value, location.href).href : a.value;
      return ` ${a.name}="${escAttr(v)}"`;
    });
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && el.checked) attrs.push(' checked');
    if (el instanceof HTMLInputElement && el.value && el.type !== 'password' && !el.hasAttribute('value')) attrs.push(` value="${escAttr(el.value)}"`);
    attrs.push(` data-ck-box="${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}"`);
    if (decl.length) attrs.push(` style="${escAttr(decl.join(';'))}"`);

    // pseudo-éléments ::before / ::after avec contenu (icônes, puces…) : rendus en <span> stylés
    const pseudo = (which: '::before' | '::after') => {
      const ps = getComputedStyle(el, which);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal') return '';
      const text = content.startsWith('"') ? content.slice(1, -1) : '';
      const s = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'margin-right', 'margin-left', 'border-top-left-radius', 'transform']
        .map((p) => `${p}:${ps.getPropertyValue(p)}`).join(';');
      return `<span data-ck-pseudo="${which.slice(2)}" style="${escAttr(s)}">${esc(text)}</span>`;
    };

    const children = [...el.childNodes].map((n) =>
      n.nodeType === Node.TEXT_NODE ? esc(n.textContent ?? '') : n.nodeType === Node.ELEMENT_NODE ? walk(n as Element, cs) : '',
    ).join('');
    const VOID = ['img', 'input', 'br', 'hr', 'source', 'col', 'wbr'];
    // <dialog> ouvert en modale : il vit dans le « top layer » avec un ::backdrop qui n'existe pas dans le DOM
    if (tag === 'dialog' && el.matches(':modal')) {
      const bd = getComputedStyle(el, '::backdrop');
      const backdrop = `<div data-ck-pseudo="backdrop" style="position:fixed;inset:0;z-index:2147483646;background-color:${bd.backgroundColor};backdrop-filter:${bd.backdropFilter}"></div>`;
      attrs.push(` data-ck-modal`);
      return `${backdrop}<${tag}${attrs.join('').replace(/ style="/, ' style="z-index:2147483647;')}>${children}</${tag}>`;
    }
    return VOID.includes(tag) ? `<${tag}${attrs.join('')}>` : `<${tag}${attrs.join('')}>${pseudo('::before')}${children}${pseudo('::after')}</${tag}>`;
  };

  const root = document.documentElement;
  const body = walk(document.body, getComputedStyle(root));
  frame.remove();
  // @font-face : seules règles de feuilles de style indispensables au rendu (polices, icônes)
  const fontFaces: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) if (rule instanceof CSSFontFaceRule) fontFaces.push(rule.cssText.replace(/url\("?([^")]+)"?\)/g, (_, u) => `url("${new URL(u, sheet.href ?? location.href).href}")`));
    } catch { /* feuille d'une autre origine */ }
  }
  const rootStyle = getComputedStyle(root);
  const html = `<!doctype html>
<html lang="${root.lang || 'en'}"><head><meta charset="utf-8"><title>${esc(document.title)}</title>
<style>${fontFaces.join('\n')}
html{background-color:${rootStyle.backgroundColor};font-family:${rootStyle.fontFamily};font-size:${rootStyle.fontSize}}*{box-sizing:border-box}</style>
</head>
${body}
</html>`;
  return { html, elements, tokens };
}

export async function captureRich(page: Page, out: string, id: string): Promise<RichResult> {
  await mkdir(join(out, 'dom'), { recursive: true });
  await mkdir(join(out, 'styled'), { recursive: true });
  const dom = `dom/${id}.html`;
  const styled = `styled/${id}.html`;
  await writeFile(join(out, dom), await page.content());
  // tsx/esbuild entoure les fonctions nommées d'un helper __name, absent dans la page
  await page.evaluate('window.__name ??= (f) => f');
  const snap = await page.evaluate(snapshotInPage);
  await writeFile(join(out, styled), snap.html);
  return { dom, styled, elements: snap.elements, bytes: snap.html.length, tokens: snap.tokens };
}

/**
 * Fidélité de la capture : on affiche le snapshot stylé (sans aucun JS de l'app) dans le même contexte
 * (cookies, polices) et on compare pixel à pixel avec la capture d'écran de l'original.
 */
export async function captureFidelity(context: BrowserContext, origin: string, styledFile: string, screenshot: string, diffOut: string): Promise<number> {
  const page = await context.newPage();
  try {
    // servi depuis l'origine de l'app : les polices sont soumises à CORS, about:blank ne pourrait pas les charger
    const at = new URL('/__clonekit_snapshot', origin).href;
    const html = await readFile(styledFile, 'utf8');
    await page.route('**/*', (r) =>
      r.request().url() === at ? r.fulfill({ contentType: 'text/html', body: html }) : r.request().resourceType() === 'script' ? r.abort() : r.continue());
    await page.goto(at, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const shot = await page.screenshot();
    const a = PNG.sync.read(await readFile(screenshot));
    const b = PNG.sync.read(shot);
    if (a.width !== b.width || a.height !== b.height) return 0;
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    await writeFile(diffOut, PNG.sync.write(diff));
    return 1 - n / (a.width * a.height);
  } finally {
    await page.close();
  }
}

/** Fusionne les comptes de tokens de tous les écrans et produit design-tokens.json + tokens.css. */
export function mergeTokens(into: TokenCounts, add: TokenCounts): void {
  for (const [k, vals] of Object.entries(add)) for (const [v, n] of Object.entries(vals)) (into[k] ??= {})[v] = (into[k][v] ?? 0) + n;
}

export function renderTokens(t: TokenCounts): { json: unknown; css: string } {
  const top = (k: string, max: number) => Object.entries(t[k] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, max);
  const json = Object.fromEntries(Object.keys(t).map((k) => [k, Object.fromEntries(top(k, 16))]));
  const vars = [
    ...top('color', 8).map(([v], i) => `  --text-${i + 1}: ${v};`),
    ...top('background', 8).map(([v], i) => `  --bg-${i + 1}: ${v};`),
    ...top('border-color', 4).map(([v], i) => `  --border-${i + 1}: ${v};`),
    ...top('font-family', 3).map(([v], i) => `  --font-${i + 1}: ${v};`),
    ...top('font-size', 8).map(([v]) => v).sort((a, b) => parseFloat(a) - parseFloat(b)).map((v, i) => `  --text-size-${i + 1}: ${v};`),
    ...top('radius', 5).map(([v]) => v).sort((a, b) => parseFloat(a) - parseFloat(b)).map((v, i) => `  --radius-${i + 1}: ${v};`),
    ...top('shadow', 3).map(([v], i) => `  --shadow-${i + 1}: ${v};`),
    ...top('spacing', 10).map(([v]) => v).sort((a, b) => parseFloat(a) - parseFloat(b)).map((v, i) => `  --space-${i + 1}: ${v};`),
  ];
  return { json, css: `/* Tokens déduits des styles calculés, classés par fréquence d'usage */\n:root {\n${vars.join('\n')}\n}\n` };
}

/** Télécharge au passage toutes les ressources statiques de l'app (CSS, polices, images, scripts). */
export class AssetCollector {
  readonly manifest = new Map<string, { url: string; type: string; file: string; bytes: number; sha: string }>();
  private pending: Promise<void>[] = [];

  constructor(private out: string, private origin: string) {}

  attach(page: Page): void {
    page.on('response', (resp) => {
      const type = resp.request().resourceType();
      const url = resp.url();
      if (!['stylesheet', 'font', 'image', 'script'].includes(type) || this.manifest.has(url) || url.startsWith('data:') || !resp.ok()) return;
      const u = new URL(url);
      const file = join('assets', u.origin === this.origin ? '' : u.host, decodeURIComponent(u.pathname).replace(/\/$/, '/index'));
      this.manifest.set(url, { url, type, file, bytes: 0, sha: '' });
      this.pending.push(resp.body().then(async (buf) => {
        await mkdir(dirname(join(this.out, file)), { recursive: true });
        await writeFile(join(this.out, file), buf);
        Object.assign(this.manifest.get(url)!, { bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex').slice(0, 16) });
      }).catch(() => { this.manifest.delete(url); }));
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);
    this.pending = [];
  }
}
