import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * App Store copy guard (owner 29.10.2026, «устрани это все»; App Review Guideline 2.1).
 *
 * The App Store build (the Kaspi customer build, release profiles storefront / production) must
 * not show «скоро / подключается / появится позже / в процессе подключения / coming soon» for a
 * feature that does not exist yet, and must not offer Apple Pay / Google Pay or show their logos as
 * payment marks. Every string literal and JSX text of apps/mobile/src (plus its KK and EN
 * translations from the catalogue) is checked. A match is allowed only when listed below with the
 * reason it never reaches the App Store build, or why it is a real temporary state. A new «скоро»
 * anywhere fails this test until it is hidden in the App Store build and listed here.
 * The browser walk (browser_store_walk.py) checks the same on the rendered Kaspi build.
 */
const SRC = fileURLToPath(new URL('../../apps/mobile/src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const catalogue = new Map(
  JSON.parse(readFileSync(join(SRC, 'i18n/messages.json'), 'utf8')).map((entry) => [
    entry.ru,
    entry,
  ]),
);

// RU, KK and EN wordings of «not there yet», and the wallet names / marks.
export const FORBIDDEN = [
  /скоро/i,
  /подключа/i,
  /не подключ[её]н/i,
  /после подключения/i,
  /в процессе подключения/i,
  /оплата в процессе/i,
  /появится позже/i,
  /появятся позже/i,
  /загляни позже/i,
  /пока не (выпускается|начисляются|даёт|активн)/i,
  /ещё не (активирован|активен)/i,
  /пробн(ый|ые|ого|ых|ом|ая)/i,
  /предварительн/i,
  /готовим программу/i,
  /готовятся/i,
  /на подготовке/i,
  /apple ?pay/i,
  /google ?pay/i,
  /logo-(apple|google)/,
  /coming soon/i,
  /being set up/i,
  /being connected/i,
  /not connected yet/i,
  /\bsoon\b/i,
  /жақында(?![а-яёәіңғүұқөһ])/i,
  /қосылып жатыр/i,
  /әлі қосылмаған/i,
  /іске қосылмаған/i,
];

const KASPI_ROUTES = ['screens/MobileScreen.tsx', /kaspiCheckoutEnabled &&\s*\[\s*'M12'/];
const UPCOMING_LIST = [
  'payment-method.ts',
  /upcoming \? methods : methods\.filter\(\(method\) => method\.available\)/,
];
const STORE_SCREENS = ['ScreenHost.tsx', /storeHidesScreen\(id, undefined, preview\)/];
const TEST_ORDERS = ['screens/MobileScreen.tsx', /!props\.preview && connectedTestOrdersEnabled/];

/**
 * [file under apps/mobile/src, exact source text, why it is allowed, gate that keeps it out of
 * the App Store build: [file, pattern that must still be there]]. Kept exhaustive and current:
 * an entry that no longer matches anything fails too.
 */
const ALLOWED = [
  // Real states, true in every build.
  [
    'commerce-presentation.ts',
    'Спасибо, что выбрали PickChick. Будем ждать снова!',
    'state: the farewell after a handed-over order (EN «See you again soon!»), not a feature',
  ],
  // Payment methods other than Kaspi.kz: listed only with EXPO_PUBLIC_UPCOMING_PAYMENTS=1 (off by
  // default, dropped from every pinned release archive) or once a method really pays.
  ['payment-method.ts', 'Apple Pay', 'flag: method name', UPCOMING_LIST],
  ['payment-method.ts', 'Google Pay', 'flag: method name', UPCOMING_LIST],
  [
    'payment-method.ts',
    'Оплатить через Apple Pay',
    'flag: handle name of that method',
    UPCOMING_LIST,
  ],
  [
    'payment-method.ts',
    'Оплатить через Google Pay',
    'flag: handle name of that method',
    UPCOMING_LIST,
  ],
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
    'flag: mark of the active method, Kaspi unless another method pays',
    ['payment-method.ts', /const available = methods\.filter\(\(method\) => method\.available\)/],
  ],
  [
    'components/PaymentChoice.tsx',
    'logo-google',
    'flag: mark of the active method, Kaspi unless another method pays',
    ['payment-method.ts', /const available = methods\.filter\(\(method\) => method\.available\)/],
  ],
  // The pre-Kaspi checkout (M12 outside the Kaspi build): simulator and design builds only.
  ['components/CheckoutPresentation.tsx', 'Apple Pay', 'non-Kaspi checkout', KASPI_ROUTES],
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
  [
    'screens/OrderScreens.tsx',
    'Оплачено.\nУже почти готовим',
    'design preview of M16 (KK «Жақында»); the Kaspi build routes M13-M21 to its own screens',
    KASPI_ROUTES,
  ],
  [
    'screens/OrderScreens.tsx',
    'Оплата через Kaspi пока подключается. Вы не создавали платёж, деньги не списываются.',
    'non-Kaspi M13-M16 placeholder; the Kaspi build routes them to its own screens',
    KASPI_ROUTES,
  ],
  [
    'screens/OrderScreens.tsx',
    'Сервис электронных чеков подключается. Приложение не создаёт имитацию фискального документа.',
    'non-Kaspi M21 placeholder; the Kaspi build routes it to its own screen',
    KASPI_ROUTES,
  ],
  // Test-order screens: EXPO_PUBLIC_ORDER_SIMULATOR / EXPO_PUBLIC_UNPAID_TEST_ORDERS, both 0 in
  // every release profile (scripts/mobile/ios_release.py).
  [
    'screens/CatalogScreens.tsx',
    'Заказ поступит на кухню. Оплата и чеки - в процессе подключения.',
    'test orders: M11 only while the test-order flow is available',
    ['screens/CatalogScreens.tsx', /testAvailable\s*\?\s*'Заказ поступит на кухню/],
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
    ['screens/KaspiCheckoutScreen.tsx', /receiptShown\(order\.receipt\)/],
  ],
  [
    'components/ComboRewardCard.tsx',
    'Сейчас показан отдельный пробный счётчик без права на подарок. После выдачи Solo, Burger, Pick или Master Combo сервер добавляет одну отметку за каждое комбо. Сеты на двоих, напитки и допы не учитываются. Завершено пробных кругов: {p0}. Остаток переносится. Бумажные отметки остаются у кассира.',
    'test orders: the practice counter of the test-order client',
    ['store-build.ts', /progress\?\.status === 'ready' && !!progress\.commercial/],
  ],
  [
    'loyalty/combo-progress.ts',
    'Пробные отметки: {p0} из 6',
    'test orders: practice counter',
    ['store-build.ts', /progress\?\.status === 'ready' && !!progress\.commercial/],
  ],
  [
    'loyalty/combo-progress.ts',
    'Пробный круг собран',
    'test orders: practice counter',
    ['store-build.ts', /progress\?\.status === 'ready' && !!progress\.commercial/],
  ],
  [
    'loyalty/combo-progress.ts',
    '6 из 6. Следующее подходящее комбо начнёт новый пробный круг. Подарок пока оформляется только по правилам акции на кассе.',
    'test orders: practice counter',
    ['store-build.ts', /progress\?\.status === 'ready' && !!progress\.commercial/],
  ],
  [
    'loyalty/combo-progress.ts',
    'После выдачи Solo, Burger, Pick или Master Combo добавится отметка. Этот счётчик пробный и пока не даёт право на подарок.',
    'test orders: practice counter',
    ['store-build.ts', /progress\?\.status === 'ready' && !!progress\.commercial/],
  ],
  // The local demo account (no EXPO_PUBLIC_CUSTOMER_AUTH=server): never in a release profile.
  [
    'screens/ProfileScreens.tsx',
    'На подготовке',
    'local demo account: documents of the demo Legal screen',
    ['screens/ProfileScreens.tsx', /if \(account\.mode === 'server'\)\s*return \(/],
  ],
  [
    'screens/ProfileScreens.tsx',
    'Оплата и чеки - в процессе подключения. В приложении можно выбрать блюда и следить за заказом.',
    'local demo account: demo Legal screen',
    ['screens/ProfileScreens.tsx', /if \(account\.mode === 'server'\)\s*return \(/],
  ],
  // Hidden in the App Store build itself (store-build.ts).
  [
    'screens/ProfileScreens.tsx',
    'Сервис уведомлений ещё не подключён. Статусы заказов доступны в приложении.',
    'App Store build: push settings only once the push service is connected',
    ['screens/ProfileScreens.tsx', /pushSettingsShown\(notifications\.connected\)/],
  ],
  [
    'components/Brand.tsx',
    '6 вершин Алматы · скоро',
    'App Store build: the menu loyalty card is not shown',
    ['screens/CatalogScreens.tsx', /upcomingFeaturesShown\(undefined, props\.preview\)/],
  ],
  [
    'screens/GameScreens.tsx',
    'Новые задания и вкусные открытия. Скоро.',
    'App Store build: «Миссии» not shown',
    [
      'screens/GameScreens.tsx',
      /upcomingFeaturesShown\(undefined, props\.preview\) \? <UpcomingEvents/,
    ],
  ],
  [
    'screens/GameScreens.tsx',
    'Скоро',
    'App Store build: «Скоро» section not shown',
    [
      'screens/GameScreens.tsx',
      /upcomingFeaturesShown\(undefined, props\.preview\) \? <UpcomingEvents/,
    ],
  ],
  [
    'screens/GameScreens.tsx',
    'Условия и награды готовятся',
    'App Store build: «Скоро» section not shown',
    [
      'screens/GameScreens.tsx',
      /upcomingFeaturesShown\(undefined, props\.preview\) \? <UpcomingEvents/,
    ],
  ],
  [
    'screens/ProfileScreen.tsx',
    'Скоро',
    'App Store build: a row without action is only «Промокоды» in the hidden «Программа Чиков»',
    ['screens/ProfileScreen.tsx', /upcomingFeaturesShown\(undefined, props\.preview\) \? \(/],
  ],
  ['loyalty/PeakScreens.tsx', 'СКОРО', 'App Store build: M23/M25 open the menu', STORE_SCREENS],
  [
    'loyalty/PeakScreens.tsx',
    'Готовим программу. Пороги, состав подарков и условия пока предварительные.',
    'App Store build: M23/M25 open the menu',
    STORE_SCREENS,
  ],
  [
    'loyalty/PeakScreens.tsx',
    'Это предварительная программа. Сейчас начисления, подарки и прогресс ещё не активированы.',
    'App Store build: M23/M25 open the menu',
    STORE_SCREENS,
  ],
  [
    'loyalty/PeakScreens.tsx',
    'Предварительные условия · подарок ещё не активен',
    'App Store build: M23/M25 open the menu',
    STORE_SCREENS,
  ],
  [
    'loyalty/PeakScreens.tsx',
    'Игра уже доступна. Наградные партии с проверкой результата готовятся.',
    'App Store build: M23/M25 open the menu',
    STORE_SCREENS,
  ],
  [
    'loyalty/PeakScreens.tsx',
    'Предлагаем общий лимит 200 Чиков в месяц за игры и миссии. Уровни и подарки пока не начисляются. Игровой счёт PICK BLOCKS не равен Чикам.',
    'App Store build: M23/M25 open the menu',
    STORE_SCREENS,
  ],
];

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

/** Every user-visible literal: strings, templates and JSX text (not imports or types). */
function literals(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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

function scan() {
  const hits = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    if (SKIPPED.some((pattern) => pattern.test(file))) continue;
    for (const { text, line } of literals(path)) {
      const entry = catalogue.get(text);
      const words = [text, entry?.kk ?? '', entry?.en ?? ''];
      const pattern = FORBIDDEN.find((re) => words.some((value) => re.test(value)));
      if (pattern) hits.push({ file, text, line, pattern: String(pattern) });
    }
  }
  return hits;
}

const key = (file, text) => `${file}\u0000${text}`;

test('the patterns catch every wording of «not there yet» and the wallet names', () => {
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
    'logo-apple',
    'Photo coming soon',
    'Promo codes are being set up.',
    'Фото жақында',
    'Kaspi, қосылып жатыр',
  ])
    assert.ok(
      FORBIDDEN.some((re) => re.test(sample)),
      sample,
    );
  for (const fine of [
    'Оплата временно недоступна',
    'Пока не работаем',
    'Нет связи с сервером',
    'Проверьте подключение и попробуйте ещё раз.',
    'Повторить подключение',
    'откроемся в 10:00',
    'Kaspi отвечает дольше обычного',
    'Оплатить с Kaspi.kz',
    'Жақындатады',
  ])
    assert.ok(!FORBIDDEN.some((re) => re.test(fine)), fine);
});

test('App Store build: no «скоро» / «подключается» / Apple Pay text outside the allowed list', () => {
  const allowed = new Set(ALLOWED.map(([file, text]) => key(file, text)));
  const unexpected = scan().filter((hit) => !allowed.has(key(hit.file, hit.text)));
  assert.deepEqual(
    unexpected.map((hit) => `${hit.file}:${hit.line} ${JSON.stringify(hit.text)} (${hit.pattern})`),
    [],
    'Hide the feature in the App Store build (store-build.ts) or reword it as a real state; list it in ALLOWED only with the reason it never reaches the App Store build.',
  );
});

test('every allowed entry is current and its gate is still in place', () => {
  const hits = new Set(scan().map((hit) => key(hit.file, hit.text)));
  for (const [file, text, why, gate] of ALLOWED) {
    assert.ok(hits.has(key(file, text)), `stale entry ${file}: ${text}`);
    assert.ok(why, `${file}: ${text} needs a reason`);
    if (!why.startsWith('state:')) {
      assert.ok(gate, `${file}: ${text} needs the gate that keeps it out of the App Store build`);
      const [gateFile, pattern] = gate;
      assert.match(
        readFileSync(join(SRC, gateFile), 'utf8'),
        pattern,
        `${file}: gate in ${gateFile}`,
      );
    }
  }
  assert.equal(new Set(ALLOWED.map(([file, text]) => key(file, text))).size, ALLOWED.length);
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
