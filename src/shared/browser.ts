import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Request, type Response } from 'playwright';
import { templateUrl } from './normalize.js';

export const VIEWPORT = { width: 1280, height: 800 };

export interface ApiCall {
  seq: number;
  method: string;
  url: string;
  template: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
  contentType?: string;
  /** Format du corps envoyé quand ce n'est pas du JSON simple (ex. "json-patch"). */
  requestFormat?: string;
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: process.env.HEADED !== '1' });
}

export async function newContext(browser: Browser, storageState?: string): Promise<BrowserContext> {
  return browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    storageState,
  });
}

// Suivi des requêtes HTTP en cours par page. On n'utilise pas `networkidle` de Playwright :
// les vraies apps gardent souvent du polling ou des requêtes longues ouvertes et ne l'atteignent jamais.
const activity = new WeakMap<Page, { inflight: number; last: number }>();

function trackActivity(page: Page): void {
  if (activity.has(page)) return;
  const state = { inflight: 0, last: Date.now() };
  activity.set(page, state);
  const relevant = (r: Request) => ['document', 'fetch', 'xhr'].includes(r.resourceType());
  page.on('request', (r) => { if (relevant(r)) { state.inflight++; state.last = Date.now(); } });
  const done = (r: Request) => { if (relevant(r)) { state.inflight = Math.max(0, state.inflight - 1); state.last = Date.now(); } };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
}

/** Enregistre les appels fetch/xhr d'une page, dans l'ordre d'émission. */
export class NetworkRecorder {
  private seq = 0;
  private calls: ApiCall[] = [];
  private pending: Promise<void>[] = [];
  // Playwright ne voit pas certains corps de requête (ex. PATCH en application/json-patch+json) :
  // on garde l'id CDP de chaque requête avec corps pour le relire via Network.getRequestPostData.
  private cdp?: Promise<CDPSession | undefined>;
  private withBody = new Map<string, string[]>();

  constructor(page: Page) {
    trackActivity(page);
    this.cdp = page.context().newCDPSession(page).then(async (cdp) => {
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (e) => {
        if (!e.request.hasPostData) return;
        const key = `${e.request.method} ${e.request.url}`;
        this.withBody.set(key, [...(this.withBody.get(key) ?? []), e.requestId]);
      });
      return cdp;
    }).catch(() => undefined); // navigateur sans CDP : on garde ce que Playwright voit
    page.on('response', (resp) => {
      const type = resp.request().resourceType();
      if (type !== 'fetch' && type !== 'xhr') return;
      this.pending.push(this.record(resp, this.seq++));
    });
  }

  private async record(resp: Response, seq: number): Promise<void> {
    const req = resp.request();
    const contentType = resp.headers()['content-type'] ?? '';
    let responseBody: unknown;
    try {
      const text = await resp.text();
      responseBody = text && contentType.includes('json') ? JSON.parse(text) : text || undefined;
    } catch {
      responseBody = undefined;
    }
    const key = `${req.method()} ${req.url()}`;
    const cdpId = this.withBody.get(key)?.shift();
    let requestBody: unknown = req.postData() ?? undefined;
    if (requestBody === undefined && cdpId) {
      const cdp = await this.cdp;
      requestBody = await cdp?.send('Network.getRequestPostData', { requestId: cdpId }).then((r) => r.postData).catch(() => undefined);
    }
    if (typeof requestBody === 'string') {
      try { requestBody = JSON.parse(requestBody); } catch { /* corps non JSON, gardé tel quel */ }
    }
    // JSON Patch (RFC 6902) : [{op, path, value}] → { champ: valeur }, pour inférer un schéma lisible
    let requestFormat: string | undefined;
    if ((req.headers()['content-type'] ?? '').includes('json-patch') && Array.isArray(requestBody)) {
      requestFormat = 'json-patch';
      requestBody = Object.fromEntries(
        requestBody.filter((o) => o && typeof o.path === 'string' && o.op !== 'remove').map((o) => [o.path.replace(/^\//, '').replace(/\//g, '.'), o.value]),
      );
    }
    this.calls.push({
      seq, method: req.method(), url: req.url(), template: templateUrl(req.url()),
      status: resp.status(), requestBody, responseBody, contentType, requestFormat,
    });
  }

  /** Attend les réponses en cours et renvoie les appels depuis le dernier flush. */
  async flush(): Promise<ApiCall[]> {
    await Promise.all(this.pending);
    this.pending = [];
    const out = this.calls.sort((a, b) => a.seq - b.seq);
    this.calls = [];
    return out;
  }
}

/**
 * Clic / cochage tel qu'un utilisateur le ferait. Beaucoup d'UIs cachent le vrai <input> (classe
 * "sr-only", 1 px, réservé aux lecteurs d'écran) et l'utilisateur clique en fait sur son <label> :
 * si l'élément n'est pas actionnable, on se rabat sur ce label.
 */
export async function activate(loc: Locator, mode: 'click' | 'check' | 'uncheck', timeout = 5000): Promise<void> {
  const act = () => (mode === 'click' ? loc.click({ timeout }) : mode === 'check' ? loc.check({ timeout }) : loc.uncheck({ timeout }));
  try {
    return await act();
  } catch (err) {
    const label = loc.locator('xpath=ancestor::label[1]');
    const id = await loc.getAttribute('id', { timeout: 1000 }).catch(() => null);
    const target = (await label.count()) ? label : id ? loc.page().locator(`label[for="${id}"]`) : undefined;
    if (!target || !(await target.count())) throw err;
    await target.first().click({ timeout });
    if (mode !== 'click' && (await loc.isChecked()) !== (mode === 'check')) throw err;
  }
}

/** Attente "l'écran est stable" : aucune requête HTTP en cours depuis `quietMs`, puis un court délai de rendu. */
export async function settle(page: Page, quietMs = 400, timeoutMs = 10_000): Promise<void> {
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
  const state = activity.get(page);
  const deadline = Date.now() + timeoutMs;
  while (state && Date.now() < deadline && (state.inflight > 0 || Date.now() - state.last < quietMs)) {
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(150);
}

/**
 * Remet la cible dans son état initial : soit un endpoint POST (`resetPath`), soit une commande
 * shell (`resetCmd`, `{url}` remplacé par l'URL de la cible) — ex. restaurer un snapshot de base.
 */
export async function resetTarget(baseUrl: string, resetPath?: string, resetCmd?: string): Promise<void> {
  if (resetCmd) await promisify(exec)(resetCmd.replaceAll('{url}', baseUrl));
  if (!resetPath) return;
  const res = await fetch(new URL(resetPath, baseUrl), { method: 'POST' });
  if (!res.ok) throw new Error(`Reset ${baseUrl}${resetPath} a échoué (${res.status})`);
}
