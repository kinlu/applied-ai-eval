import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

/** Recorded in every report, so a run can be traced to the harness version that scored it. */
export const TOOL = { name: pkg.name, version: pkg.version };
