// Exécution complète d'un diff (utilisée par la commande `diff` et par la boucle de correction).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from '../shared/browser.js';
import { compareScenario, type Channel, type ScenarioResult } from './compare.js';
import { writeReport } from './report.js';
import { runScenario, type Scenario } from './scenario.js';

export interface DiffOptions {
  original: string;
  clone: string;
  scenarios: string;
  out: string;
  only?: string;
  resetPath?: string;
  resetCmd?: string;
  storageOriginal?: string;
  storageClone?: string;
  calibrate: boolean;
  calibrateRuns: number;
  channels?: Channel[];
  log?: (line: string) => void;
}

export async function runDiff(o: DiffOptions) {
  const log = o.log ?? ((l: string) => console.log(l));
  const files = (await readdir(o.scenarios)).filter((f) => f.endsWith('.json')).sort();
  const scenarios: Scenario[] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(o.scenarios, f), 'utf8'))));
  const selected = o.only ? scenarios.filter((s) => s.name === o.only) : scenarios;
  if (!selected.length) throw new Error(`Aucun scénario trouvé${o.only ? ` pour "${o.only}"` : ''}`);

  const startedAt = new Date();
  const browser = await launch();
  const results: ScenarioResult[] = [];
  try {
    for (const [i, sc] of selected.entries()) {
      const dir = join(o.out, `${String(i + 1).padStart(2, '0')}-${sc.name.replace(/\W+/g, '-').toLowerCase()}`);
      const [orig, clone] = await Promise.all([
        runScenario(browser, o.original, sc, join(dir, 'original'), { resetPath: o.resetPath, resetCmd: o.resetCmd, storageState: o.storageOriginal }),
        runScenario(browser, o.clone, sc, join(dir, 'clone'), { resetPath: o.resetPath, resetCmd: o.resetCmd, storageState: o.storageClone }),
      ]);
      // Calibration : l'original rejoué à nouveau. Tout écart original ↔ original est du bruit
      // (ordre non déterministe, valeurs aléatoires…) et sera ignoré dans la comparaison avec le clone.
      const noise = new Set<string>();
      for (let k = 1; o.calibrate && k <= o.calibrateRuns; k++) {
        const calibDir = join(dir, `original-calib-${k}`);
        const again = await runScenario(browser, o.original, sc, calibDir, { resetPath: o.resetPath, resetCmd: o.resetCmd, storageState: o.storageOriginal });
        const calib = await compareScenario(sc, orig, again, calibDir);
        for (const f of calib.findings) {
          noise.add(f.signature);
          if (f.noiseKey) noise.add(f.noiseKey);
        }
      }
      const r = await compareScenario(sc, orig, clone, dir, noise, o.channels && new Set(o.channels));
      results.push(r);
      log(`  ${r.passed === r.total ? '✔' : '✗'} ${sc.name.padEnd(40)} ${((r.passed / Math.max(1, r.total)) * 100).toFixed(1).padStart(5)} %  (${r.findings.length} écarts bruts${r.suppressed.length ? `, ${r.suppressed.length} ignorés car instables sur l'original` : ''})`);
    }
  } finally {
    await browser.close();
  }
  const rep = await writeReport(o.out, { original: o.original, clone: o.clone, startedAt, durationMs: Date.now() - startedAt.getTime() }, results);
  return { ...rep, out: o.out };
}
