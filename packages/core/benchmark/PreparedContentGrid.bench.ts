import { bench, describe } from 'vitest';
import { prepareContentGrid } from '../src/text/PreparedContentGrid';

const metrics = {
  font: '15px monospace',
  cellWidth: 9,
  lineHeight: 24,
  baseline: 18,
} as const;

function repeatRows(row: string, count: number): string {
  return Array.from({ length: count }, () => row).join('\n');
}

function fixedWidthAscii(columns: number): string {
  return 'const value = office_affinity_123; '.repeat(Math.ceil(columns / 35)).slice(0, columns);
}

function fixedWidthUnicode(columns: number): string {
  const clusters = ['你', '👩‍💻', '\t', 'م', 'ر', 'ح', 'ب', 'ا', 'A', '1'];
  return Array.from({ length: columns }, (_, index) => clusters[index % clusters.length]).join('');
}

describe('prepareContentGrid', () => {
  for (const rows of [10, 100, 1000]) {
    bench(`ASCII ${rows} rows x 80 input characters`, () => {
      prepareContentGrid(repeatRows(fixedWidthAscii(80), rows), metrics);
    });
    bench(`mixed Unicode ${rows} rows x 80 input grapheme clusters`, () => {
      prepareContentGrid(repeatRows(fixedWidthUnicode(80), rows), metrics);
    });
  }
});
