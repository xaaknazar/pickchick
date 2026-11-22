import type { Locale } from './i18n.ts';
import type { TerminalSetupResult } from './model';
/**
 * ADR-0018: texts of the payment on the kiosk's Kaspi Smart POS (guest) and of its staff setup.
 * Plain hyphen only (owner rule). KZ wording: to be checked by a native speaker.
 */
const ru = {
  // Guest: pay on the terminal
  title: 'Оплатите на терминале',
  subtitle: 'картой или в приложении Kaspi.kz',
  pointer: 'Терминал Kaspi - рядом с экраном',
  /** Start screen chip. */
  chip: 'Оплата на терминале Kaspi',
  toPay: 'К оплате',
  starting: 'Отправляем сумму на терминал…',
  waiting: 'Экран обновится сам, как только оплата пройдёт.',
  checking: 'Уточняем результат на терминале. Не оплачивайте повторно.',
  paid: 'Оплата прошла. Передаём заказ на кухню…',
  offline: 'Нет ответа - проверяем снова. Не оплачивайте повторно.',
  failedTitle: 'Оплата не прошла',
  cancelledTitle: 'Оплата отменена на терминале',
  failedBody: 'Деньги не списаны. Можно повторить оплату или начать заказ заново.',
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
  /** Owner 22.11.2026: after a failed or cancelled payment, an empty menu. */
  toMenu: 'В меню',
  /** Owner 22.11.2026: back to the cart with the same dishes after a failed or cancelled payment. */
  editOrder: 'Изменить заказ',
  /** While the terminal waits: the iPad cannot cancel it, the guest cancels on the terminal. */
  cancelOrEdit: 'Отменить или изменить заказ',
  cancelOnTerminal:
    'Нажмите «Отмена» на терминале. Деньги не спишутся, а здесь появится кнопка «Изменить заказ».',
  staff: 'Сотруднику',
  noCancelTitle: 'Оплату нельзя отменить на киоске',
  noCancel: 'Если передумали, не оплачивайте на терминале и пригласите сотрудника.',
  /** Staff dialog: the service reset of a terminal payment whose result is not known. */
  staffResetBody:
    'Оплата на терминале не подтверждена. Сначала проверьте операцию на экране терминала. После сброса заказ уйдёт менеджеру на сверку, на кухню он не попадёт.',
  /** Review screen: the payment method when the terminal takes it. */
  method: 'На терминале Kaspi - картой или Kaspi.kz',
  // Staff: terminal setup (behind the staff code)
  setupOpen: 'Терминал Kaspi',
  setupTitle: 'Терминал Kaspi',
  setupBody:
    'Терминал и iPad должны быть в одной сети. IP терминала: «Настройки» → «Kaspi Гид» → «О терминале».',
  host: 'IP-адрес терминала',
  link: 'Подключить',
  confirmTitle: 'Нажмите «Разрешить» на терминале',
  confirmBody:
    'На экране терминала появится запрос от pickchick-kiosk. Если его нет: «Панель главного кассира» → «Защита интеграции» (включена) → «Настроить доступ».',
  /** The pinned certificate (start and end of its SHA-256), HTTPS links. */
  confirmCertificate: 'Сертификат терминала',
  certificate: 'Сертификат',
  plainHttp: 'Без шифрования (HTTP)',
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
  result_certificate: 'Терминал отвечает с другим сертификатом. Проверьте IP или привяжите заново.',
  result_protection:
    'Терминал работает без защиты. Включите на терминале «Защита интеграции», нажмите «Настроить доступ» и повторите.',
  result_busy: 'Сейчас идёт заказ гостя. Повторите на заставке.',
};
type Strings = { [K in keyof typeof ru]: string };
const kk: Strings = {
  title: 'Терминалда төлеңіз',
  subtitle: 'картамен немесе Kaspi.kz қосымшасында',
  pointer: 'Kaspi терминалы - экранның жанында',
  chip: 'Kaspi терминалында төлеу',
  toPay: 'Төлеуге',
  starting: 'Соманы терминалға жіберудеміз…',
  waiting: 'Төлем өткенде экран өзі жаңарады.',
  checking: 'Нәтижені терминалдан нақтылаудамыз. Қайта төлемеңіз.',
  paid: 'Төлем өтті. Тапсырысты асүйге жіберудеміз…',
  offline: 'Жауап жоқ - қайта тексереміз. Қайта төлемеңіз.',
  failedTitle: 'Төлем өтпеді',
  cancelledTitle: 'Төлем терминалда тоқтатылды',
  failedBody: 'Ақша алынған жоқ. Төлемді қайталауға немесе тапсырысты қайта бастауға болады.',
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
  toMenu: 'Мәзірге',
  editOrder: 'Тапсырысты өзгерту',
  cancelOrEdit: 'Тапсырысты болдырмау не өзгерту',
  cancelOnTerminal:
    'Терминалда төлемді болдырмаңыз. Ақша алынбайды, ал мұнда «Тапсырысты өзгерту» түймесі шығады.',
  staff: 'Қызметкерге',
  noCancelTitle: 'Төлемді киоскіде жоюға болмайды',
  noCancel: 'Ойыңыз өзгерсе, терминалда төлемеңіз және қызметкерді шақырыңыз.',
  staffResetBody:
    'Терминалдағы төлем расталмады. Алдымен операцияны терминал экранынан тексеріңіз. Қалпына келтіргеннен кейін тапсырыс менеджерге салыстыруға жіберіледі, асүйге түспейді.',
  method: 'Kaspi терминалында - картамен немесе Kaspi.kz',
  setupOpen: 'Kaspi терминалы',
  setupTitle: 'Kaspi терминалы',
  setupBody:
    'Терминал мен iPad бір желіде болуы керек. Терминалдың IP мекенжайы: «Баптаулар» → «Kaspi Гид» → «Терминал туралы».',
  host: 'Терминалдың IP мекенжайы',
  link: 'Қосу',
  confirmTitle: 'Терминалда «Рұқсат ету» түймесін басыңыз',
  confirmBody:
    'Терминал экранында pickchick-kiosk сұрауы шығады. Егер ол жоқ болса: «Бас кассир панелі» → «Интеграцияны қорғау» (қосулы) → «Қолжетімділікті баптау».',
  confirmCertificate: 'Терминал сертификаты',
  certificate: 'Сертификат',
  plainHttp: 'Шифрлаусыз (HTTP)',
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
  result_certificate:
    'Терминал басқа сертификатпен жауап береді. IP мекенжайын тексеріңіз немесе қайта байлаңыз.',
  result_protection:
    'Терминал қорғаусыз жұмыс істеп тұр. Терминалда «Интеграцияны қорғау» функциясын қосып, «Қолжетімділікті баптау» түймесін басып, қайталаңыз.',
  result_busy: 'Қазір қонақтың тапсырысы жүріп жатыр. Бастапқы экранда қайталаңыз.',
};
const en: Strings = {
  title: 'Pay on the terminal',
  subtitle: 'by card or in the Kaspi.kz app',
  pointer: 'The Kaspi terminal is next to the screen',
  chip: 'Pay on the Kaspi terminal',
  toPay: 'To pay',
  starting: 'Sending the amount to the terminal…',
  waiting: 'This screen updates by itself once the payment goes through.',
  checking: 'Checking the result on the terminal. Do not pay again.',
  paid: 'Payment received. Sending your order to the kitchen…',
  offline: 'No answer - checking again. Do not pay again.',
  failedTitle: 'Payment failed',
  cancelledTitle: 'Payment cancelled on the terminal',
  failedBody: 'No money was taken. You can try again or start a new order.',
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
  toMenu: 'Back to menu',
  editOrder: 'Change order',
  cancelOrEdit: 'Cancel or change order',
  cancelOnTerminal:
    'Press «Cancel» on the terminal. No money is taken, and «Change order» appears here.',
  staff: 'Staff',
  noCancelTitle: 'The payment cannot be cancelled on the kiosk',
  noCancel: 'If you changed your mind, do not pay on the terminal and call a team member.',
  staffResetBody:
    'The terminal payment is not confirmed. First check the operation on the terminal screen. After the reset the order goes to the manager for review and never reaches the kitchen.',
  method: 'On the Kaspi terminal - card or Kaspi.kz',
  setupOpen: 'Kaspi terminal',
  setupTitle: 'Kaspi terminal',
  setupBody:
    'The terminal and the iPad must be on the same network. Terminal IP: Settings → Kaspi Guide → About the terminal.',
  host: 'Terminal IP address',
  link: 'Connect',
  confirmTitle: 'Press Allow on the terminal',
  confirmBody:
    'The terminal shows a request from pickchick-kiosk. If it does not: Senior cashier panel → Integration protection (on) → Set up access.',
  confirmCertificate: 'Terminal certificate',
  certificate: 'Certificate',
  plainHttp: 'Not encrypted (HTTP)',
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
  result_certificate:
    'The terminal answers with a different certificate. Check the IP or link it again.',
  result_protection:
    'The terminal runs without protection. Turn on Integration protection on the terminal, press Set up access and try again.',
  result_busy: 'A guest order is in progress. Try again on the start screen.',
};
const table: Record<Locale, Strings> = { ru, kk, en };
export type TerminalCopy = Strings;
export const terminalCopyForTest = table;
export const terminalCopy = (locale: string): TerminalCopy =>
  locale === 'kk' || locale === 'en' ? table[locale] : ru;
export const terminalResultText = (t: TerminalCopy, result: TerminalSetupResult) =>
  t[`result_${result}`];
