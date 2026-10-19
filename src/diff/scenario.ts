// Scénarios rejouables : la même suite d'actions utilisateur est exécutée sur l'original
// et sur le clone ; après chaque étape on capture une "observation" complète.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { activate, NetworkRecorder, newContext, resetTarget, settle, type ApiCall } from '../shared/browser.js';
import { templateUrl } from '../shared/normalize.js';

export type Target =
  | { role: string; name: string; exact?: boolean; nth?: number }
  | { css: string; nth?: number }
  | { text: string; nth?: number };

export type Step = { label?: string } & (
  | { goto: string }
  | { click: Target }
  | { fill: Target; value: string }
  | { select: Target; value: string }
  | { check: Target }
  | { uncheck: Target }
  | { press: string; on?: Target }
  | { wait: number }
);

export interface Scenario {
  name: string;
  description?: string;
  steps: Step[];
  /** Sélecteurs CSS masqués sur les captures (zones dynamiques : horloges, avatars…). */
  mask?: string[];
  /** Clés JSON supplémentaires à ignorer dans la comparaison d'API. */
  ignoreKeys?: string[];
}

export interface Observation {
  step: number;
  label: string;
  error?: string;
  url: string;
  template: string;
  aria: string;
  screenshot: string;
  calls: ApiCall[];
}

export function describeStep(s: Step): string {
  if (s.label) return s.label;
  const t = (x: Target) =>
    'role' in x ? `${x.role} "${x.name}"` : 'css' in x ? `\`${x.css}\`` : `texte "${x.text}"`;
  if ('goto' in s) return `aller sur ${s.goto}`;
  if ('click' in s) return `cliquer ${t(s.click)}`;
  if ('fill' in s) return `saisir "${s.value}" dans ${t(s.fill)}`;
  if ('select' in s) return `choisir "${s.value}" dans ${t(s.select)}`;
  if ('check' in s) return `cocher ${t(s.check)}`;
  if ('uncheck' in s) return `décocher ${t(s.uncheck)}`;
  if ('press' in s) return `touche ${s.press}${s.on ? ` sur ${t(s.on)}` : ''}`;
  return `attendre ${s.wait} ms`;
}

function locate(page: Page, t: Target): Locator {
  const base =
    'role' in t
      ? page.getByRole(t.role as Parameters<Page['getByRole']>[0], { name: t.name, exact: t.exact ?? true })
      : 'css' in t
        ? page.locator(t.css)
        : page.getByText(t.text, { exact: true });
  return base.nth(t.nth ?? 0);
}

async function run(page: Page, baseUrl: string, s: Step): Promise<void> {
  const opts = { timeout: 5000 };
  if ('goto' in s) await page.goto(new URL(s.goto, baseUrl).toString());
  else if ('click' in s) await activate(locate(page, s.click), 'click');
  else if ('fill' in s) await locate(page, s.fill).fill(s.value, opts);
  else if ('select' in s) await locate(page, s.select).selectOption(s.value, opts);
  else if ('check' in s) await activate(locate(page, s.check), 'check');
  else if ('uncheck' in s) await activate(locate(page, s.uncheck), 'uncheck');
  else if ('press' in s) await (s.on ? locate(page, s.on).press(s.press, opts) : page.keyboard.press(s.press));
  else await page.waitForTimeout(s.wait);
}

export async function runScenario(
  browser: Browser,
  baseUrl: string,
  scenario: Scenario,
  outDir: string,
  opts: { resetPath?: string; resetCmd?: string; storageState?: string },
): Promise<Observation[]> {
  await mkdir(outDir, { recursive: true });
  await resetTarget(baseUrl, opts.resetPath, opts.resetCmd);
  const context = await newContext(browser, opts.storageState);
  const page = await context.newPage();
  const net = new NetworkRecorder(page);
  const observations: Observation[] = [];

  try {
    for (const [i, step] of scenario.steps.entries()) {
      let error: string | undefined;
      try {
        await run(page, baseUrl, step);
        await settle(page);
      } catch (err) {
        error = (err as Error).message.split('\n')[0];
      }
      const screenshot = join(outDir, `step-${i}.png`);
      await page.screenshot({ path: screenshot, mask: (scenario.mask ?? []).map((m) => page.locator(m)) });
      observations.push({
        step: i,
        label: describeStep(step),
        error,
        url: page.url(),
        template: templateUrl(page.url()),
        aria: await page.locator('body').ariaSnapshot().catch(() => ''),
        screenshot,
        calls: await net.flush(),
      });
      if (error) break; // la suite du scénario n'a plus de sens sur ce côté
    }
  } finally {
    await context.close();
  }
  return observations;
}
