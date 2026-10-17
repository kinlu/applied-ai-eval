/**
 * `aieval rescore <run>`: recomputes every measurement from a run's saved
 * outputs with the current checks and case files, without calling the app.
 * Use it when only metric definitions, thresholds or gold changed, so the
 * baseline does not have to be regenerated (and paid for) to compare.
 */
import { relative, resolve } from 'node:path';
import { DEFAULT_CHECKS } from './checks/index.js';
import { loadConfig } from './config.js';
import { casesForRun, loadArtifact } from './judge.js';
import { measureResult } from './measure.js';
import { buildRunMarkdown } from './report.js';
import type { RunReport } from './types.js';
import { readJson, writeJson, writeText } from './util.js';

export interface RescoreOptions {
  runDir: string;
  config?: string;
  cwd?: string;
  out?: string;
  log?: (line: string) => void;
}

export async function rescoreRunDir(options: RescoreOptions): Promise<{ outDir: string; report: RunReport }> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const cwd = options.cwd ?? process.cwd();
  const runDir = resolve(cwd, options.runDir);
  const report = readJson<RunReport>(resolve(runDir, 'report.json'));
  const loaded = await loadConfig(options.config, options.cwd);
  const cases = casesForRun(loaded.casesDir, loaded.holdoutDir, report, log);
  const outDir = resolve(cwd, options.out ?? `${runDir.replace(/\/+$/, '')}-rescored`);

  const runs = report.runs.map((run) => {
    const loadedCase = cases.get(run.caseId);
    const artifact = loadArtifact(runDir, report, run);
    if (!loadedCase || !artifact) {
      log(`warning: ${run.caseId} · ${run.variant} s${run.sample}: ${artifact ? 'case missing' : 'artifact missing'}; kept unchanged`);
      return run;
    }
    const measured = measureResult(loadedCase, artifact.result, loaded.config, artifact.status, artifact.error);
    return { ...run, gates: measured.gates, traps: measured.traps, measurements: measured.measurements };
  });

  const rescored: RunReport = {
    ...report,
    checks: loaded.config.checks ?? DEFAULT_CHECKS,
    ...(loaded.config.tolerances ? { tolerances: loaded.config.tolerances } : {}),
    rescoredAtIso: new Date().toISOString(),
    rescoredFromIso: report.startedIso,
    artifactsDir: relative(outDir, resolve(runDir, report.artifactsDir)) || '.',
    runs,
  };
  writeJson(resolve(outDir, 'report.json'), rescored);
  writeText(resolve(outDir, 'report.md'), buildRunMarkdown(rescored));
  log(`Re-scored ${runs.length} run(s) → ${outDir}`);
  return { outDir, report: rescored };
}
