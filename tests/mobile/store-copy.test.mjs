import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * App Store copy guard (owner 29.10.2026, «устрани это все»; App Review Guideline 2.1).
 *
 * The App Store build (the Kaspi customer build, release profiles storefront / production) must
 * not show «скоро / подключается / появится позже / в процессе подключения / coming soon», nor the
 * softer «ещё не / пока не / not yet / will be available / once ... connected» (KK «әлі»,
 * «әзірге», «қосылуда»), for a feature that does not exist; must not mention the Chiki programme
 * or show «Без фото» placeholders; and must not offer Apple Pay / Google Pay / a bank card or show
 * their logos as payment marks. Every string literal and JSX text of apps/mobile/src (plus its KK
 * and EN translations from the catalogue) is checked against store-copy-patterns.json, the same
 * list the browser walk (browser_store_walk.py) applies to the rendered build.
 *
 * A match is allowed only:
 * - as a real temporary state (store-copy-patterns.json «states»: closed, payment pending, bank or
 *   restaurant not answering), true at the moment it is shown;
 * - in ALLOWED, with the reason it never reaches the App Store build and its gate;
 * - in a whole file of HIDDEN_FILES, whose only importers are listed and gated.
 * A gate is checked structurally (TypeScript AST): every use of the gate expression (or of the
 * variable it is stored in) must be the condition of a ?:, an `if` or a `&&` chain, never inside
 * `||` or `!`. The test proves this by mutating each gate (`true || gate`, `gate || true`, `!gate`)
 * and expecting the check to fail (review 29.10.2026: `true || upcomingFeaturesShown(...)` passed).
 */
const SRC = fileURLToPath(new URL('../../apps/mobile/src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHARED = JSON.parse(
  readFileSync(new URL('./store-copy-patterns.json', import.meta.url), 'utf8'),
);
const catalogue = new Map(
  JSON.parse(readFileSync(join(SRC, 'i18n/messages.json'), 'utf8')).map((entry) => [
    entry.ru,
    entry,
  ]),
);

export const FORBIDDEN = [
  ...SHARED.patterns.map((source) => new RegExp(source, 'i')),
  /logo-(apple|google)/,
];

// Gates. `call`: the expression (as written) that keeps the text out of the App Store build;
// checked structurally. `pattern`: a declaration whose behaviour has its own unit test
// (store-build.test.mjs, payment-method.test.mjs), checked by presence.
const KASPI_ROUTES = {
  file: 'screens/MobileScreen.tsx',
  call: 'kaspiCheckoutEnabled',
  pattern: /kaspiCheckoutEnabled &&\s*\[\s*'M12'/,
};
const UPCOMING_LIST = {
  file: 'payment-method.ts',
  pattern: /upcoming \? methods : methods\.filter\(\(method\) => method\.available\)/,
};
const ONLY_AVAILABLE = {
  file: 'payment-method.ts',
  pattern: /const available = methods\.filter\(\(method\) => method\.available\)/,
};
const STORE_SCREENS = { file: 'ScreenHost.tsx', call: 'storeHidesScreen(id, undefined, preview)' };
const TEST_ORDERS = { file: 'screens/MobileScreen.tsx', call: 'connectedTestOrdersEnabled' };
const COMBO_SERVER = {
  file: 'store-build.ts',
  pattern: /progress\?\.status === 'ready' && !!progress\.commercial/,
};
const DEMO_LEGAL = { file: 'screens/ProfileScreens.tsx', call: "account.mode === 'server'" };
const DEMO_DATA = { file: 'screens/ProfileScreens.tsx', call: "demo.mode === 'demo'" };
const PUSH = {
  file: 'screens/ProfileScreens.tsx',
  call: 'pushSettingsShown(notifications.connected)',
};
const upcoming = (file) => ({ file, call: 'upcomingFeaturesShown(undefined, props.preview)' });

/** Whole files that are not part of the App Store build: [file, why, importers, gates]. */
const HIDDEN_FILES = [
  [
    'screens/OrderScreens.tsx',
    'pre-Kaspi M13-M21 (the Kaspi build routes them to KaspiCheckoutScreen) and the M22-M25 previews (the App Store build opens the menu)',
    ['screens/MobileScreen.tsx'],
    [KASPI_ROUTES, STORE_SCREENS],
  ],
  [
    'loyalty/PeakScreens.tsx',
    'the Chiki wallet and missions, only behind M23 / M25',
    ['screens/OrderScreens.tsx'],
    [STORE_SCREENS],
  ],
  [
    'loyalty/peaks.ts',
    'data of the Chiki peaks, only for PeakScreens',
    ['loyalty/PeakScreens.tsx'],
    [STORE_SCREENS],
  ],
];

/** [file under apps/mobile/src, exact source text, why it never reaches the App Store build, gate]. */
const ALLOWED = [
  // Payment methods other than Kaspi.kz: listed only with EXPO_PUBLIC_UPCOMING_PAYMENTS=1 (off by
  // default, dropped from every pinned release archive) or once a method really pays.
  ['payment-method.ts', 'Apple Pay', 'flag: method name', UPCOMING_LIST],
  ['payment-method.ts', 'Google Pay', 'flag: method name', UPCOMING_LIST],
  ['payment-method.ts', 'Банковская карта', 'flag: method name', UPCOMING_LIST],
  ['payment-method.ts', 'Оплатить через Apple Pay', 'flag: handle name', UPCOMING_LIST],
  ['payment-method.ts', 'Оплатить через Google Pay', 'flag: handle name', UPCOMING_LIST],
  ['payment-method.ts', 'Оплатить банковской картой', 'flag: handle name', UPCOMING_LIST],
  [
    'payment-method.ts',
    'Этот способ оплаты пока не подключён. Заказ не оформлен, деньги не списаны. Выберите Kaspi.kz в «Способе оплаты».',
    'flag: only when a method other than Kaspi is available and chosen (never in this build)',
    UPCOMING_LIST,
  ],
  ['components/CartSheet.tsx', 'logo-apple', 'flag: mark of a disabled row', UPCOMING_LIST],
  ['components/CartSheet.tsx', 'logo-google', 'flag: mark of a disabled row', UPCOMING_LIST],
  ['components/CartSheet.tsx', '{p0}, скоро', 'flag: name of a disabled row', UPCOMING_LIST],
  ['components/CartSheet.tsx', 'СКОРО', 'flag: label of a disabled row', UPCOMING_LIST],
  [
    'components/PaymentChoice.tsx',
    'logo-apple',
    'flag: mark of an available non-Kaspi method',
    ONLY_AVAILABLE,
  ],
  [
    'components/PaymentChoice.tsx',
    'logo-google',
    'flag: mark of an available non-Kaspi method',
    ONLY_AVAILABLE,
  ],
  [
    'components/PaymentChoice.tsx',
    'Банковская карта',
    'flag: name of an available card method',
    ONLY_AVAILABLE,
  ],
  // The pre-Kaspi checkout (M12 outside the Kaspi build): simulator and design builds only.
  ['components/CheckoutPresentation.tsx', 'Apple Pay', 'non-Kaspi checkout', KASPI_ROUTES],
  ['components/CheckoutPresentation.tsx', 'Банковская карта', 'non-Kaspi checkout', KASPI_ROUTES],
  ['components/CheckoutPresentation.tsx', '{p0}, скоро', 'non-Kaspi checkout', KASPI_ROUTES],
  ['components/CheckoutPresentation.tsx', 'logo-apple', 'non-Kaspi checkout', KASPI_ROUTES],
  ['components/CheckoutPresentation.tsx', 'СКОРО', 'non-Kaspi checkout', KASPI_ROUTES],
  ['components/CartExtras.tsx', 'Kaspi, подключается', 'non-Kaspi checkout', KASPI_ROUTES],
  ['components/CartExtras.tsx', 'Подключается', 'non-Kaspi checkout', KASPI_ROUTES],
  [
    'components/CartExtras.tsx',
    'Оплата и чеки - в процессе подключения.',
    'non-Kaspi checkout',
    KASPI_ROUTES,
  ],
  ['screens/CheckoutScreen.tsx', 'Оформление скоро появится', 'non-Kaspi checkout', KASPI_ROUTES],
  ['screens/CheckoutScreen.tsx', 'В корзине пока пусто', 'non-Kaspi checkout', KASPI_ROUTES],
  // Test-order screens: EXPO_PUBLIC_ORDER_SIMULATOR / EXPO_PUBLIC_UNPAID_TEST_ORDERS, both 0 in
  // every release profile (scripts/mobile/ios_release.py).
  [
    'screens/CatalogScreens.tsx',
    'Заказ поступит на кухню. Оплата и чеки - в процессе подключения.',
    'test orders: M11 only while the test-order flow is available',
    { file: 'screens/CatalogScreens.tsx', call: 'testAvailable' },
  ],
  [
    'screens/ConnectedFeedback.tsx',
    'Приём сообщений ещё не подключён на сервере. Попробуйте позже или обратитесь к сотруднику ресторана.',
    'test orders',
    TEST_ORDERS,
  ],
  [
    'screens/ConnectedOrderScreens.tsx',
    'Оплата и чеки - в процессе подключения.',
    'test orders',
    TEST_ORDERS,
  ],
  [
    'screens/ConnectedOrderScreens.tsx',
    'Оплата и чеки - в процессе подключения',
    'test orders',
    TEST_ORDERS,
  ],
  [
    'screens/OrderStatusScreen.tsx',
    'Чеки и оплата в процессе',
    'test orders: OrderStatusScreen; the Kaspi status passes its own receipt tile',
    { file: 'screens/KaspiCheckoutScreen.tsx', call: 'receiptShown(order.receipt)' },
  ],
  [
    'components/ComboRewardCard.tsx',
    'Сейчас показан отдельный пробный счётчик без права на подарок. После выдачи Solo, Burger, Pick или Master Combo сервер добавляет одну отметку за каждое комбо. Сеты на двоих, напитки и допы не учитываются. Завершено пробных кругов: {p0}. Остаток переносится. Бумажные отметки остаются у кассира.',
    'test orders: the practice counter of the test-order client',
    COMBO_SERVER,
  ],
  [
    'loyalty/combo-progress.ts',
    'Отметки пока у кассира',
    'App Store build: no card while the server programme is off',
    COMBO_SERVER,
  ],
  [
    'loyalty/combo-progress.ts',
    'Пробные отметки: {p0} из 6',
    'test orders: practice counter',
    COMBO_SERVER,
  ],
  [
    'loyalty/combo-progress.ts',
    'Пробный круг собран',
    'test orders: practice counter',
    COMBO_SERVER,
  ],
  [
    'loyalty/combo-progress.ts',
    '6 из 6. Следующее подходящее комбо начнёт новый пробный круг. Подарок пока оформляется только по правилам акции на кассе.',
    'test orders: practice counter',
    COMBO_SERVER,
  ],
  [
    'loyalty/combo-progress.ts',
    'После выдачи Solo, Burger, Pick или Master Combo добавится отметка. Этот счётчик пробный и пока не даёт право на подарок.',
    'test orders: practice counter',
    COMBO_SERVER,
  ],
  // The local demo account (no EXPO_PUBLIC_CUSTOMER_AUTH=server): never in a release profile.
  [
    'screens/ProfileScreens.tsx',
    'На подготовке',
    'local demo account: demo Legal screen',
    DEMO_LEGAL,
  ],
  [
    'screens/ProfileScreens.tsx',
    'Правила программы Чиков',
    'local demo account: demo Legal screen',
    DEMO_LEGAL,
  ],
  [
    'screens/ProfileScreens.tsx',
    'Документ ещё не утверждён и не опубликован компанией Pick Chick. Здесь нет действующей оферты или условий программы.',
    'local demo account: demo Legal screen',
    DEMO_LEGAL,
  ],
  [
    'screens/ProfileScreens.tsx',
    'Оплата и чеки - в процессе подключения. В приложении можно выбрать блюда и следить за заказом.',
    'local demo account: demo Legal screen',
    DEMO_LEGAL,
  ],
  [
    'screens/ProfileScreens.tsx',
    'Когда появится аккаунт, удалить его можно будет здесь после подтверждения личности. Обязательные сроки хранения документов будут описаны в политике.',
    'local demo account: data screen',
    DEMO_DATA,
  ],
  // Hidden in the App Store build itself (store-build.ts).
  [
    'screens/ProfileScreens.tsx',
    'Сервис уведомлений ещё не подключён. Статусы заказов доступны в приложении.',
    'App Store build: push settings only once the push service is connected',
    PUSH,
  ],
  [
    'screens/ProfileScreens.tsx',
    'Отправка пока недоступна',
    'M35 rating placeholder: the App Store build opens the menu',
    STORE_SCREENS,
  ],
  [
    'components/Brand.tsx',
    'Открыть мои Чики',
    'App Store build: the menu loyalty card is not shown',
    upcoming('screens/CatalogScreens.tsx'),
  ],
  [
    'components/Brand.tsx',
    'Чики за любимый вкус',
    'App Store build: the menu loyalty card is not shown',
    upcoming('screens/CatalogScreens.tsx'),
  ],
  [
    'components/Brand.tsx',
    '6 вершин Алматы · скоро',
    'App Store build: the menu loyalty card is not shown',
    upcoming('screens/CatalogScreens.tsx'),
  ],
  [
    'screens/GameScreens.tsx',
    'Новые задания и вкусные открытия. Скоро.',
    'App Store build: «Миссии» not shown',
    upcoming('screens/GameScreens.tsx'),
  ],
  [
    'screens/GameScreens.tsx',
    'Скоро',
    'App Store build: «Скоро» section not shown',
    upcoming('screens/GameScreens.tsx'),
  ],
  [
    'screens/GameScreens.tsx',
    'Условия и награды готовятся',
    'App Store build: «Скоро» section not shown',
    upcoming('screens/GameScreens.tsx'),
  ],
  [
    'screens/ProfileScreen.tsx',
    'Скоро',
    'App Store build: «Промокоды» of the hidden «Программа Чиков»',
    upcoming('screens/ProfileScreen.tsx'),
  ],
  [
    'screens/ProfileScreen.tsx',
    'Мои Чики и уровни',
    'App Store build: the hidden Chiki rows',
    upcoming('screens/ProfileScreen.tsx'),
  ],
  [
    'screens/ProfileScreen.tsx',
    'Программа Чиков',
    'App Store build: the hidden Chiki rows',
    upcoming('screens/ProfileScreen.tsx'),
  ],
];
const STATES = SHARED.states.map(({ file, text, why }) => [file, text, `state: ${why}`]);

// Whole areas that are not part of the App Store build at all.
const SKIPPED = [
  // Pick Farm: EXPO_PUBLIC_PICK_FARM=0 in storefront/production; its route opens «События».
  /^games\/pick-farm\//,
  // Storybook stories are not bundled into the app.
  /\.stories\.tsx$/,
];

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}
const parse = (file, text) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
const srcFile = (path) => relative(SRC, path).split(sep).join('/');

/** Every user-visible literal: strings, templates and JSX text (not imports or types). */
function literals(file) {
  const source = parse(file, readFileSync(file, 'utf8'));
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node))
      return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      found.push({
        text: node.text,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    else if (ts.isJsxText(node) && node.text.trim())
      found.push({
        text: node.text.trim(),
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const hiddenFiles = new Set(HIDDEN_FILES.map(([file]) => file));
function scan() {
  const hits = [];
  for (const path of sources(SRC)) {
    const file = srcFile(path);
    if (SKIPPED.some((pattern) => pattern.test(file)) || hiddenFiles.has(file)) continue;
    for (const { text, line } of literals(path)) {
      const entry = catalogue.get(text);
      const words = [text, entry?.kk ?? '', entry?.en ?? ''];
      const pattern = FORBIDDEN.find((re) => words.some((value) => re.test(value)));
      if (pattern) hits.push({ file, text, line, pattern: String(pattern) });
    }
  }
  return hits;
}

/** Files that import `target` (import / export-from declarations), as src-relative paths. */
function importers(target) {
  const found = new Set();
  for (const path of sources(SRC)) {
    const file = srcFile(path);
    if (/\.stories\.tsx$/.test(file)) continue;
    const source = parse(path, readFileSync(path, 'utf8'));
    for (const statement of source.statements) {
      const spec =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      if (!spec?.startsWith('.')) continue;
      const resolved = normalize(join(dirname(file), spec))
        .split(sep)
        .join('/');
      if ([resolved, `${resolved}.ts`, `${resolved}.tsx`].includes(target)) found.add(file);
    }
  }
  return [...found].sort();
}

/**
 * Is the expression a gate: the condition of `?:` / `if`, or part of a `&&` chain that is such a
 * condition or guards JSX (`{gate && <X />}`)? Inside `||`, `??` or `!` it is not.
 */
function gating(node) {
  let current = node;
  let viaAnd = false;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent)) current = parent;
    else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      current = parent;
      viaAnd = true;
    } else break;
  }
  const parent = current.parent;
  return (
    (ts.isConditionalExpression(parent) && parent.condition === current) ||
    (ts.isIfStatement(parent) && parent.expression === current) ||
    (viaAnd && ts.isJsxExpression(parent))
  );
}

/** Uses of a gate expression in a file: direct uses, or every read of the variable holding it. */
function gateUses(source, call) {
  const direct = [];
  const visit = (node) => {
    if (
      (ts.isIdentifier(node) ||
        ts.isCallExpression(node) ||
        ts.isBinaryExpression(node) ||
        ts.isPropertyAccessExpression(node)) &&
      node.getText(source) === call &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    )
      direct.push(node);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  const uses = [];
  for (const node of direct) {
    const parent = node.parent;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name)
    ) {
      const name = parent.name.text;
      const reads = (child) => {
        if (
          ts.isIdentifier(child) &&
          child.text === name &&
          child !== parent.name &&
          !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child) &&
          !ts.isPropertyAssignment(child.parent)
        )
          uses.push(child);
        ts.forEachChild(child, reads);
      };
      reads(source);
    } else uses.push(node);
  }
  return uses;
}

function gateHolds(gate, text = readFileSync(join(SRC, gate.file), 'utf8')) {
  if (gate.pattern && !gate.pattern.test(text)) return false;
  if (!gate.call) return true;
  const uses = gateUses(parse(gate.file, text), gate.call);
  return uses.length > 0 && uses.every(gating);
}

const key = (file, text) => `${file}\u0000${text}`;

test('the patterns catch every wording of «not there yet», Chiki, placeholders and wallets', () => {
  for (const sample of [
    '6 вершин Алматы · скоро',
    'Kaspi, подключается',
    'Сервис уведомлений ещё не подключён.',
    'Push-уведомления появятся после подключения сервиса',
    'Оплата и чеки - в процессе подключения',
    'Фискальный чек пока не выпускается',
    'Загляни позже - здесь появится новая игра.',
    'Оплатить через Apple Pay',
    'Google Pay',
    'Photo coming soon',
    'Good things are coming',
    'Promo codes are being set up.',
    'Фото жақында',
    'Kaspi, қосылып жатыр',
    // Review 29.10.2026: these passed the earlier, narrower list.
    'Оплата Kaspi ещё не открыта для вашего аккаунта.',
    'Kaspi payments are not enabled for your account yet.',
    'Оформление пока недоступно для вашего аккаунта.',
    'Оплата картой ещё не доступна',
    'Оплата картой еще не доступна',
    'Card payments will be available later',
    'Card payments will be available once the bank is connected.',
    'Карта қосылуда',
    'Карта әлі қолжетімсіз',
    'Әзірге жабық',
    'Чтобы оформлять заказы, копить Чики и играть в игры',
    'points don’t earn Chiki',
    'Без фото',
    'No photo',
    'Ссылка на него уточняется.',
    'Пока их статус можно посмотреть в разделе «Заказы».',
    'Explore Events in the meantime.',
    'Вход по SMS станет доступен после их утверждения.',
  ])
    assert.ok(
      FORBIDDEN.some((re) => re.test(sample)),
      sample,
    );
  for (const fine of [
    'Оплата временно недоступна',
    'Нет связи с сервером',
    'Проверьте подключение и попробуйте ещё раз.',
    'Повторить подключение',
    'откроемся в 10:00',
    'Kaspi отвечает дольше обычного',
    'Оплатить с Kaspi.kz',
    'Жақындатады',
    'Для этого аккаунта оплата заказов выключена. Как проходит заказ - можно посмотреть без оплаты.',
    'Ordering is turned off for this account. You can see how ordering works without payment.',
    'Мәзірге оралу',
    'Тапсырыс мәліметтері',
    'Pick Chick',
    'Твой Чик. Любимое меню.',
    'Позиция сейчас недоступна',
  ])
    assert.ok(!FORBIDDEN.some((re) => re.test(fine)), fine);
});

test('App Store build: no forbidden wording outside the states, the allowed list and hidden files', () => {
  const allowed = new Set([...ALLOWED, ...STATES].map(([file, text]) => key(file, text)));
  const unexpected = scan().filter((hit) => !allowed.has(key(hit.file, hit.text)));
  assert.deepEqual(
    unexpected.map((hit) => `${hit.file}:${hit.line} ${JSON.stringify(hit.text)} (${hit.pattern})`),
    [],
    'Reword it as a true, present-tense sentence, hide the feature in the App Store build (store-build.ts), or list it with its reason and gate.',
  );
});

test('every allowed entry and state is current and every gate holds', () => {
  const hits = new Set(scan().map((hit) => key(hit.file, hit.text)));
  for (const [file, text, why, gate] of [...ALLOWED, ...STATES]) {
    assert.ok(hits.has(key(file, text)), `stale entry ${file}: ${text}`);
    assert.ok(why, `${file}: ${text} needs a reason`);
    if (why.startsWith('state:')) continue;
    assert.ok(gate, `${file}: ${text} needs the gate that keeps it out of the App Store build`);
    assert.ok(
      gateHolds(gate),
      `${file}: ${text} - gate ${gate.call ?? gate.pattern} in ${gate.file}`,
    );
  }
  const all = [...ALLOWED, ...STATES].map(([file, text]) => key(file, text));
  assert.equal(new Set(all).size, all.length);
});

test('hidden files are imported only by their listed, gated importers', () => {
  for (const [file, why, expected, gates] of HIDDEN_FILES) {
    assert.ok(why, file);
    assert.deepEqual(importers(file), [...expected].sort(), `${file}: importers`);
    for (const gate of gates)
      assert.ok(gateHolds(gate), `${file}: gate ${gate.call ?? gate.pattern}`);
  }
});

test('a defeated gate fails the check (true ||, || true, !)', () => {
  const gates = new Map();
  for (const [, , , gate] of ALLOWED) if (gate?.call) gates.set(`${gate.file}:${gate.call}`, gate);
  for (const [, , , list] of HIDDEN_FILES)
    for (const gate of list) if (gate.call) gates.set(`${gate.file}:${gate.call}`, gate);
  assert.ok(gates.size >= 8, 'structural gates');
  for (const gate of gates.values()) {
    const text = readFileSync(join(SRC, gate.file), 'utf8');
    assert.ok(gateHolds(gate, text), `${gate.file}: ${gate.call} holds`);
    const uses = gateUses(parse(gate.file, text), gate.call);
    for (const use of uses)
      for (const wrap of [(x) => `(true || ${x})`, (x) => `(${x} || true)`, (x) => `!${x}`]) {
        const start = use.getStart();
        const mutated =
          text.slice(0, start) + wrap(text.slice(start, use.getEnd())) + text.slice(use.getEnd());
        assert.equal(
          gateHolds(gate, mutated),
          false,
          `${gate.file}: ${wrap(gate.call)} at ${start} must fail`,
        );
      }
  }
});

test('the App Store release profiles are the Kaspi build without the upcoming payments list', () => {
  const release = readFileSync(join(ROOT, 'scripts/mobile/ios_release.py'), 'utf8');
  assert.match(release, /CUSTOMER_PILOT_FLAGS = \{[^}]*"EXPO_PUBLIC_KASPI_CHECKOUT": "1"/);
  assert.match(release, /STOREFRONT_FLAGS = \{\*\*CUSTOMER_PILOT_FLAGS/);
  assert.match(release, /PRODUCTION_FLAGS = \{\*\*STOREFRONT_FLAGS/);
  assert.doesNotMatch(release, /"EXPO_PUBLIC_UPCOMING_PAYMENTS": "1"/);
  assert.match(release, /env\.pop\("EXPO_PUBLIC_UPCOMING_PAYMENTS", None\)/);
  // The test orders and the farm stay off in the release profiles.
  assert.match(release, /"EXPO_PUBLIC_ORDER_SIMULATOR": "0"/);
  assert.match(release, /"EXPO_PUBLIC_UNPAID_TEST_ORDERS": "0"/);
  assert.match(release, /STOREFRONT_FLAGS = \{[^}]*"EXPO_PUBLIC_PICK_FARM": "0"/);
});
