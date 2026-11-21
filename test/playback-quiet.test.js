// Zamek invariantu: ticho je default, hlasite jen explicitne po akci uzivatele.
// Automaticke cesty (boot/probuzeni/pripominka/watchdog) nesmi nikdy shodit 'on' ani toastovat,
// jinak by se mrtvy stream uz nikdy nezkusil znovu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

test('applySelection je defaultne ticha', () => {
  assert.match(src, /async function applySelection\(quiet = true\)/);
});

test('playStation je defaultne ticha', () => {
  assert.match(src, /async function playStation\(st, quiet = true[,)]/);
});

test('renderIdle v prehravaci jen v hlasite vetvi', () => {
  // Ticha cesta drzi stav pro retry (if quiet), hlasita uklizi (if !quiet / else).
  const holdCount = (src.match(/if \(quiet\)/g) || []).length;
  const loudCount = (src.match(/if \(!quiet\)/g) || []).length;
  assert.ok(holdCount >= 1 && loudCount >= 2, 'chybi vetveni quiet v prehravaci');
});
