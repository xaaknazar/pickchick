import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { format } from 'prettier';
import { groups, stateNames } from '../design/prototype/ui.js';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const screens = JSON.parse(await read('design/prototype/screens.json'));
const tokens = JSON.parse(await read('packages/design-tokens/tokens.json'));
const ids = new Set(screens.map((s) => s.id));
assert.equal(ids.size, screens.length, 'Duplicate screen IDs');
const required = [
  ...(await read('docs/01-technical-spec.md')).matchAll(/\*\*((?:MOB|KIO|POS|KDS)-\d{2})\./g),
].map((m) => m[1]);
// Device distribution/lockdown is accepted on supervised hardware, not a
// customer-facing screen. Keep its coverage explicit instead of inventing UI.
const operationalRequirements = new Map([['KIO-06', 'docs/operations/ipad-kiosk-lockdown.md']]);
for (const [requirement, document] of operationalRequirements) {
  assert(required.includes(requirement), `Unknown operational requirement: ${requirement}`);
  assert((await read(document)).trim(), `Missing acceptance document: ${document}`);
}
for (const requirement of required)
  assert(
    screens.some((s) => s.requirement === requirement) || operationalRequirements.has(requirement),
    `Missing ${requirement}`,
  );
for (const s of screens) {
  assert(groups[s.surface] && s.id && s.title && s.purpose && s.kind && s.requirement);
  assert(ids.has(s.next), `Broken next: ${s.id} → ${s.next}`);
  assert(s.states.includes('default') && s.states.every((v) => stateNames[v]), `States: ${s.id}`);
  assert.equal(new Set(s.states).size, s.states.length);
  assert(Array.isArray(s.fields) && ['P0', 'P1'].includes(s.release));
}
for (const [key, g] of Object.entries(groups)) {
  assert.deepEqual(g.size, tokens.viewport[key], `Viewport drift: ${key}`);
  assert(ids.has(g.first));
}
const css = await read('packages/design-tokens/tokens.css');
for (const [key, hex] of Object.entries(tokens.color)) {
  const name =
    { brandBlue: 'blue', brandOrange: 'orange' }[key] ??
    key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  assert(css.toLowerCase().includes(`--${name}: ${hex.toLowerCase()};`), `Color drift: ${key}`);
}
for (const [theme, colors] of Object.entries(tokens.theme)) {
  for (const [key, hex] of Object.entries(colors)) {
    const name = `${theme}-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`;
    assert(css.toLowerCase().includes(`--${name}: ${hex.toLowerCase()};`), `Theme drift: ${name}`);
  }
}
for (const asset of JSON.parse(await read('design/prototype/assets/mockup/provenance.json'))) {
  const bytes = await readFile(
    new URL('../design/prototype/assets/mockup/' + asset.file, import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    asset.sha256,
    `Mockup asset drift: ${asset.file}`,
  );
}
for (const asset of JSON.parse(await read('design/prototype/assets/provenance.json'))) {
  const bytes = await readFile(
    new URL('../design/prototype/assets/' + asset.file, import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    asset.sha256,
    `Asset modified: ${asset.file}`,
  );
}
const luminance = (hex) =>
  hex
    .slice(1)
    .match(/../g)
    .map((c) => parseInt(c, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const pairs = [
  ['ink', 'surface'],
  ['muted', 'surface'],
  ['surface', 'brandBlue'],
  ['ink', 'brandOrange'],
  ['success', 'successSoft'],
  ['warning', 'warningSoft'],
  ['danger', 'dangerSoft'],
  ['darkText', 'darkSurface'],
  ['darkMuted', 'darkSurface'],
];
const contrast = pairs.map(([fg, bg]) => {
  const values = [luminance(tokens.color[fg]), luminance(tokens.color[bg])].sort((a, b) => b - a);
  const ratio = (values[0] + 0.05) / (values[1] + 0.05);
  assert(ratio >= 4.5, `Insufficient text contrast: ${fg}/${bg}`);
  return `| ${fg} / ${bg} | ${ratio.toFixed(2)}:1 |`;
});
const lines = [
  '# Каталог экранов PickChick v0.2',
  '',
  'Генерируется командой `pnpm design:catalog` из `design/prototype/screens.json`. Редактировать источник, затем обновлять каталог. `pnpm design:check` проверяет связи, покрытие именованных требований, токены и неизменность исходных изображений.',
  '',
  `Всего ${screens.length} экранов и ${screens.reduce((n, s) => n + s.states.length, 0)} сочетаний экран/состояние. Количество не означает готовность функциональных приложений. Общие состояния используют переиспользуемые шаблоны; переходы и правила реализации описаны в [handoff](handoff.md).`,
  '',
  '## Связь с ТЗ',
  '',
  'MOB/KIO/POS/KDS — идентификаторы §4.1–4.4. DSP — §4.5. BO-* — проектные обозначения разделов таблицы §4.6 (новых требований не вводят). LOY/GAME — §5. P0/P1 — порядок дизайна, согласованный scope не изменяется.',
  '',
  '| Требование / раздел | Экраны |',
  '|---|---|',
];
for (const r of new Set(screens.map((s) => s.requirement)))
  lines.push(
    `| ${r} | ${screens
      .filter((s) => s.requirement === r)
      .map((s) => s.id)
      .join(', ')} |`,
  );
for (const [requirement, document] of operationalRequirements)
  lines.push(
    `| ${requirement} | Приёмка устройства и распространения: [процедура](../${document.slice(5)}) |`,
  );
for (const [key, g] of Object.entries(groups)) {
  const list = screens.filter((s) => s.surface === key);
  lines.push(
    '',
    `## ${g.name} — ${list.length} экранов`,
    '',
    '| ID | Страница | Требование | Основной переход | Приоритет |',
    '|---|---|---|---|---|',
  );
  for (const s of list)
    lines.push(`| ${s.id} | ${s.title} | ${s.requirement} | ${s.next} | ${s.release} |`);
  for (const s of list) {
    lines.push(
      '',
      `### ${s.id} · ${s.title}`,
      '',
      s.purpose + '.',
      '',
      'Открыть: `http://127.0.0.1:4173/#' + s.id + '`. Основной переход: ' + s.next + '.',
      '',
      `Состояния: ${s.states.map((v) => stateNames[v]).join('; ')}.`,
    );
    if (s.fields.length) lines.push('', `Поля: ${s.fields.join('; ')}.`);
    if (s.financial)
      lines.push(
        '',
        'Финансовый контекст: UI отображает доверенное состояние. Переход по экрану не подтверждает деньги, чек или начисление.',
      );
  }
}
lines.push(
  '',
  '## Контраст основных текстовых пар',
  '',
  'Расчёт относительной яркости sRGB. Это проверка перечисленных токенов, не аудит всех пикселей/состояний и не сертификация WCAG.',
  '',
  '| Пара | Контраст |',
  '|---|---|',
  ...contrast,
  '',
);
const result = await format(lines.join('\n'), { parser: 'markdown', printWidth: 100 });
const target = 'docs/design/screen-catalog.md';
if (process.argv.includes('--check'))
  assert.equal(await read(target), result, 'Regenerate design catalog');
else await writeFile(new URL('../' + target, import.meta.url), result);
console.log(
  `Design: ${screens.length} screens; ${required.length} named requirements; ${pairs.length} contrast pairs; assets and tokens verified.`,
);
