import type { Locale } from './i18n.ts';
import type { TerminalSetupResult } from './model';
/**
 * ADR-0018: texts of the payment on the kiosk's Kaspi Smart POS (guest) and of its staff setup.
 * Plain hyphen only (owner rule). KZ wording: to be checked by a native speaker.
 */
const ru = {
  // Guest: pay on the terminal
  title: 'Оплатите на терминале',
  subtitle: 'картой или Kaspi QR',
  pointer: 'Терминал Kaspi - рядом с экраном',
  toPay: 'К оплате',
  starting: 'Отправляем сумму на терминал…',
  waiting: 'Приложите карту или отсканируйте QR на экране терминала. Экран обновится сам.',
  checking: 'Уточняем результат на терминале. Не оплачивайте повторно.',
  paid: 'Оплата прошла. Передаём заказ на кухню…',
  offline: 'Нет ответа - проверяем снова. Не оплачивайте повторно.',
  failedTitle: 'Оплата не прошла',
  cancelledTitle: 'Оплата отменена на терминале',
  failedBody: 'Деньги не списаны. Попробуйте ещё раз или вернитесь к заказу.',
  notStartedTitle: 'Терминал не начал оплату',
  notStartedBody: 'Деньги не списаны.',
  reason_busy: 'Терминал занят прошлой операцией. Завершите её на терминале и нажмите «Повторить».',
  reason_blocked: 'Оплаты на терминале заблокированы. Пригласите сотрудника.',
  reason_token:
    'Терминал не принял ключ киоска. Нажмите «Повторить», если не поможет - пригласите сотрудника.',
  reason_unreachable:
    'Нет связи с терминалом. Проверьте, что он включён и в сети, и нажмите «Повторить».',
  reason_refused: 'Терминал отказал в оплате. Нажмите «Повторить» или пригласите сотрудника.',
  lostTitle: 'Проверяем оплату',
  lostBody:
    'Ответ терминала не пришёл. Не оплачивайте повторно - пригласите сотрудника, он проверит операцию на терминале.',
  retry: 'Повторить',
  leave: 'Вернуться к заказу',
  staff: 'Сотруднику',
  /** Staff dialog: the service reset of a terminal payment whose result is not known. */
  staffResetBody:
    'Оплата на терминале не подтверждена. Сначала проверьте операцию на экране терминала. После сброса заказ уйдёт менеджеру на сверку, на кухню он не попадёт.',
  /** Review screen: the payment method when the terminal takes it. */
  method: 'Картой или Kaspi QR на терминале',
  // Staff: terminal setup (behind the staff code)
  setupOpen: 'Терминал Kaspi',
  setupTitle: 'Терминал Kaspi',
  setupBody:
    'Терминал и iPad должны быть в одной сети. IP терминала: «Настройки» → «Kaspi Гид» → «О терминале».',
  host: 'IP-адрес терминала',
  link: 'Подключить',
  confirmTitle: 'Нажмите «Разрешить» на терминале',
  confirmBody:
    'На экране терминала появится запрос от pickchick-kiosk. Если его нет: «Настройки» → «Панель администратора» → «Защита интеграции» → «Настроить доступ».',
  linkedTitle: 'Подключён терминал',
  terminalId: 'ID терминала',
  serial: 'Серийный номер',
  ip: 'IP-адрес',
  check: 'Проверить связь',
  unlink: 'Отвязать',
  close: 'Закрыть',
  cloudPending: 'Сервер ещё не знает этот терминал. Нажмите «Проверить связь».',
  disabled: 'Оплата на терминале выключена на сервере - гости платят по QR на экране киоска.',
  result_linked: 'Терминал подключён.',
  result_ok: 'Связь с терминалом есть.',
  result_unlinked: 'Терминал отвязан. Гости платят по QR на экране киоска.',
  result_host: 'Введите частный IPv4-адрес, например 192.168.1.50.',
  result_unreachable: 'Терминал не отвечает. Проверьте IP и что iPad в той же сети.',
  result_denied: 'Терминал не выдал доступ. Нажмите «Разрешить» на терминале и повторите.',
  result_pending:
    'Прошлый запрос доступа ещё ждёт ответа на терминале. Ответьте на него и повторите.',
  result_taken: 'Этот терминал привязан к другому киоску. Сначала отвяжите его там.',
  result_cloud: 'Не удалось сохранить на сервере. Проверьте связь и нажмите «Проверить связь».',
  result_mismatch: 'По этому адресу отвечает другой терминал. Отвяжите и подключите заново.',
  result_busy: 'Сейчас идёт заказ гостя. Повторите на заставке.',
};
type Strings = { [K in keyof typeof ru]: string };
const kk: Strings = {
  title: 'Терминалда төлеңіз',
  subtitle: 'картамен немесе Kaspi QR арқылы',
  pointer: 'Kaspi терминалы - экранның жанында',
  toPay: 'Төлеуге',
  starting: 'Соманы терминалға жіберудеміз…',
  waiting:
    'Картаны жақындатыңыз немесе терминал экранындағы QR-ды сканерлеңіз. Экран өзі жаңарады.',
  checking: 'Нәтижені терминалдан нақтылаудамыз. Қайта төлемеңіз.',
  paid: 'Төлем өтті. Тапсырысты асүйге жіберудеміз…',
  offline: 'Жауап жоқ - қайта тексереміз. Қайта төлемеңіз.',
  failedTitle: 'Төлем өтпеді',
  cancelledTitle: 'Төлем терминалда тоқтатылды',
  failedBody: 'Ақша алынған жоқ. Қайта көріңіз немесе тапсырысқа оралыңыз.',
  notStartedTitle: 'Терминал төлемді бастамады',
  notStartedBody: 'Ақша алынған жоқ.',
  reason_busy:
    'Терминал алдыңғы операциямен бос емес. Оны терминалда аяқтап, «Қайталау» түймесін басыңыз.',
  reason_blocked: 'Терминалда төлемдер бұғатталған. Қызметкерді шақырыңыз.',
  reason_token:
    'Терминал киоск кілтін қабылдамады. «Қайталау» түймесін басыңыз, көмектеспесе - қызметкерді шақырыңыз.',
  reason_unreachable:
    'Терминалмен байланыс жоқ. Оның қосулы және желіде екенін тексеріп, «Қайталау» түймесін басыңыз.',
  reason_refused:
    'Терминал төлемнен бас тартты. «Қайталау» түймесін басыңыз немесе қызметкерді шақырыңыз.',
  lostTitle: 'Төлемді тексерудеміз',
  lostBody:
    'Терминалдан жауап келмеді. Қайта төлемеңіз - қызметкерді шақырыңыз, ол операцияны терминалда тексереді.',
  retry: 'Қайталау',
  leave: 'Тапсырысқа оралу',
  staff: 'Қызметкерге',
  staffResetBody:
    'Терминалдағы төлем расталмады. Алдымен операцияны терминал экранынан тексеріңіз. Қалпына келтіргеннен кейін тапсырыс менеджерге салыстыруға жіберіледі, асүйге түспейді.',
  method: 'Терминалда картамен немесе Kaspi QR арқылы',
  setupOpen: 'Kaspi терминалы',
  setupTitle: 'Kaspi терминалы',
  setupBody:
    'Терминал мен iPad бір желіде болуы керек. Терминалдың IP мекенжайы: «Баптаулар» → «Kaspi Гид» → «Терминал туралы».',
  host: 'Терминалдың IP мекенжайы',
  link: 'Қосу',
  confirmTitle: 'Терминалда «Рұқсат ету» түймесін басыңыз',
  confirmBody:
    'Терминал экранында pickchick-kiosk сұрауы шығады. Егер ол жоқ болса: «Баптаулар» → «Әкімші панелі» → «Интеграцияны қорғау» → «Қолжетімділікті баптау».',
  linkedTitle: 'Қосылған терминал',
  terminalId: 'Терминал ID',
  serial: 'Сериялық нөмір',
  ip: 'IP мекенжайы',
  check: 'Байланысты тексеру',
  unlink: 'Ажырату',
  close: 'Жабу',
  cloudPending: 'Сервер бұл терминалды әлі білмейді. «Байланысты тексеру» түймесін басыңыз.',
  disabled: 'Терминалда төлеу серверде өшірулі - қонақтар киоск экранындағы QR арқылы төлейді.',
  result_linked: 'Терминал қосылды.',
  result_ok: 'Терминалмен байланыс бар.',
  result_unlinked: 'Терминал ажыратылды. Қонақтар киоск экранындағы QR арқылы төлейді.',
  result_host: 'Жеке IPv4 мекенжайын енгізіңіз, мысалы 192.168.1.50.',
  result_unreachable:
    'Терминал жауап бермейді. IP мекенжайын және iPad сол желіде екенін тексеріңіз.',
  result_denied: 'Терминал рұқсат бермеді. Терминалда «Рұқсат ету» түймесін басып, қайталаңыз.',
  result_pending: 'Алдыңғы рұқсат сұрауы терминалда жауап күтуде. Оған жауап беріп, қайталаңыз.',
  result_taken: 'Бұл терминал басқа киоскке байланған. Алдымен оны сол жерде ажыратыңыз.',
  result_cloud:
    'Серверде сақтау мүмкін болмады. Байланысты тексеріп, «Байланысты тексеру» түймесін басыңыз.',
  result_mismatch: 'Бұл мекенжай бойынша басқа терминал жауап береді. Ажыратып, қайта қосыңыз.',
  result_busy: 'Қазір қонақтың тапсырысы жүріп жатыр. Бастапқы экранда қайталаңыз.',
};
const en: Strings = {
  title: 'Pay on the terminal',
  subtitle: 'by card or Kaspi QR',
  pointer: 'The Kaspi terminal is next to the screen',
  toPay: 'To pay',
  starting: 'Sending the amount to the terminal…',
  waiting: 'Tap your card or scan the QR on the terminal screen. This screen updates itself.',
  checking: 'Checking the result on the terminal. Do not pay again.',
  paid: 'Payment received. Sending your order to the kitchen…',
  offline: 'No answer - checking again. Do not pay again.',
  failedTitle: 'Payment failed',
  cancelledTitle: 'Payment cancelled on the terminal',
  failedBody: 'No money was taken. Try again or go back to your order.',
  notStartedTitle: 'The terminal did not start the payment',
  notStartedBody: 'No money was taken.',
  reason_busy:
    'The terminal is busy with a previous operation. Finish it on the terminal and press Try again.',
  reason_blocked: 'Payments are blocked on the terminal. Please call a team member.',
  reason_token:
    'The terminal did not accept the kiosk key. Press Try again; if that does not help, call a team member.',
  reason_unreachable:
    'No connection to the terminal. Check that it is on and online, then press Try again.',
  reason_refused: 'The terminal refused the payment. Press Try again or call a team member.',
  lostTitle: 'Checking the payment',
  lostBody:
    'The terminal did not answer. Do not pay again - call a team member to check the operation on the terminal.',
  retry: 'Try again',
  leave: 'Back to my order',
  staff: 'Staff',
  staffResetBody:
    'The terminal payment is not confirmed. First check the operation on the terminal screen. After the reset the order goes to the manager for review and never reaches the kitchen.',
  method: 'Card or Kaspi QR on the terminal',
  setupOpen: 'Kaspi terminal',
  setupTitle: 'Kaspi terminal',
  setupBody:
    'The terminal and the iPad must be on the same network. Terminal IP: Settings → Kaspi Guide → About the terminal.',
  host: 'Terminal IP address',
  link: 'Connect',
  confirmTitle: 'Press Allow on the terminal',
  confirmBody:
    'The terminal shows a request from pickchick-kiosk. If it does not: Settings → Administrator panel → Integration protection → Set up access.',
  linkedTitle: 'Linked terminal',
  terminalId: 'Terminal ID',
  serial: 'Serial number',
  ip: 'IP address',
  check: 'Check connection',
  unlink: 'Unlink',
  close: 'Close',
  cloudPending: 'The server does not know this terminal yet. Press Check connection.',
  disabled: 'Terminal payments are off on the server - guests pay by the QR on the kiosk screen.',
  result_linked: 'Terminal connected.',
  result_ok: 'The terminal answers.',
  result_unlinked: 'Terminal unlinked. Guests pay by the QR on the kiosk screen.',
  result_host: 'Enter a private IPv4 address, for example 192.168.1.50.',
  result_unreachable:
    'The terminal does not answer. Check the IP and that the iPad is on the same network.',
  result_denied: 'The terminal did not grant access. Press Allow on the terminal and try again.',
  result_pending: 'A previous access request still waits on the terminal. Answer it and try again.',
  result_taken: 'This terminal is linked to another kiosk. Unlink it there first.',
  result_cloud: 'Could not save on the server. Check the connection and press Check connection.',
  result_mismatch: 'Another terminal answers at this address. Unlink and connect again.',
  result_busy: 'A guest order is in progress. Try again on the start screen.',
};
const table: Record<Locale, Strings> = { ru, kk, en };
export type TerminalCopy = Strings;
export const terminalCopyForTest = table;
export const terminalCopy = (locale: string): TerminalCopy =>
  locale === 'kk' || locale === 'en' ? table[locale] : ru;
export const terminalResultText = (t: TerminalCopy, result: TerminalSetupResult) =>
  t[`result_${result}`];
