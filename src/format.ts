/**
 * Number formatting shared by the run report and the comparison.
 */
import type { Unit } from './types.js';

function trimNumber(value: number, digits: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function formatValue(value: number | null | undefined, unit: Unit): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  switch (unit) {
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
    case 'score':
      return value.toFixed(2);
    case 'ms':
      return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
    case 'usd':
      return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
    case 'tokens':
    case 'chars':
      return String(Math.round(value));
    case 'count':
    default:
      return trimNumber(value, 1);
  }
}

export function formatDelta(delta: number | null | undefined, unit: Unit): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return '–';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const magnitude = Math.abs(delta);
  switch (unit) {
    case 'ratio':
      return `${sign}${(magnitude * 100).toFixed(1)} pts`;
    case 'score':
      return `${sign}${magnitude.toFixed(2)}`;
    case 'ms':
      return `${sign}${(magnitude / 1000).toFixed(magnitude < 10_000 ? 2 : 1)} s`;
    case 'usd':
      return `${sign}$${magnitude.toFixed(magnitude < 0.01 ? 5 : 4)}`;
    case 'tokens':
    case 'chars':
      return `${sign}${Math.round(magnitude)}`;
    case 'count':
    default:
      return `${sign}${trimNumber(magnitude, 1)}`;
  }
}

/** "±1.2 pts" style spread across samples, or an empty string with one sample. */
export function formatSpread(spread: number | null | undefined, unit: Unit): string {
  if (spread === null || spread === undefined || spread === 0) return '';
  return ` (spread ${formatDelta(spread, unit).replace(/^[+−±]/, '')})`;
}

export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '–';
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct).toFixed(1)}%`;
}
