# PickChick — источники и границы проверки

Проверено 6 сентября 2026. Использованы официальные источники. Архитектура, мощности, SLO, последовательность работ и проектные контракты в остальных документах — наши рекомендации; источники ниже не являются обещанием поставщиков выполнить весь проект.

| № | Источник | Что подтверждает / предел вывода |
|---|---|---|
| S01 | [Закон РК «О персональных данных и их защите»](https://www.adilet.zan.kz/rus/docs/Z1300000094) | Ст. 12 — хранение в базе на территории РК; трансграничная передача регулируется отдельно. Конкретную схему потоков и правовые основания проверять применительно к продукту |
| S02 | [Kaspi: с чем интегрируется Smart POS](https://guide.kaspi.kz/partner/ru/pos/conditions/q2722) | Интеграция с кассовым и учётным ПО предусмотрена; не подтверждает выдачу PickChick удалённого API |
| S03 | [Kaspi Smart POS — инструкция](https://guide.kaspi.kz/partner/ru/pos/documents/Smart-POS-Dokymentatsia-po-integratsii) · [публичный PDF](https://guide.kaspi.kz/cdn/content/pay/product/documents/Kaspi%20POS/Smart-POS-Dokymentatsia-po-integratsii.pdf?ri=d47ce324-abdc-4900-9f97-6b1a53b3007a) | Доступные индексированные выдержки указывают LAN/Wi-Fi, приватную общую сеть, HTTPS и регистрацию/токен. Полный PDF веб-инструментом не получен; детали endpoint/операций не заявлены проверенными |
| S04 | [Webkassa — официальный сайт](https://webkassa.kz/) | Публично заявлена API-интеграция; не доказывает пригодность конкретной конфигурации при отключённом WAN |
| S05 | [КГД: временное отсутствие связи и ККМ](https://astana.kgd.gov.kz/ru/news/otnositelno-primeneniya-kkm-pri-vremennom-otsutstvii-podklyucheniya-k-seti-telekommunikaciy-2) | Разъяснение об автономном режиме и фискальном признаке. Материал 2023 года; конкретные действующие сроки и модель ККМ нужно проверить на дату запуска |
| S06 | [Яндекс: работа с доставкой на своей кассе](https://yandex.com/project/eats/uz/rest_faq_integration) | Интеграция ресторанных заказов/меню/статусов; страница для Узбекистана, её условия допуска/подключения не применены к Казахстану |
| S07 | [Яндекс Доставка: настройка интеграции](https://yandex.ru/support/delivery-profile/ru/express/set-up-integration) | Сценарий заказа доставок из CMS/CRM/ERP, отличный от входящих заказов ресторанного агрегатора |
| S08 | [Expo: development builds](https://docs.expo.dev/develop/development-builds/introduction/) | Собственная development-сборка для разработки приложения; Expo Go не универсальная среда для собственных нативных интеграций |
| S09 | [Expo: процесс разработки](https://docs.expo.dev/workflow/overview/) | React Native/Expo и возможность локальной либо сервисной сборки |
| S10 | [Apple: SMS AutoFill с привязкой к домену](https://developer.apple.com/documentation/security/enabling-autofill-for-domain-bound-sms-codes) | Формат доменных SMS и привязка приложения/домена; не гарантия автозаполнения во всех условиях |
| S11 | [Google: SMS Retriever](https://developers.google.com/identity/sms-retriever/overview) | Автоматическое получение подходящего SMS через Google Play services и app hash |
| S12 | [NestJS](https://docs.nestjs.com/) | TypeScript/Node.js backend framework; выбор для PickChick — рекомендация, не требование поставщика |
| S13 | [PostgreSQL: ограничения](https://www.postgresql.org/docs/18/ddl-constraints.html) | CHECK/FK/UNIQUE и границы CHECK для межстрочных условий |
| S14 | [BullMQ: идемпотентные задачи](https://docs.bullmq.io/patterns/idempotent-jobs) | Безопасный повтор задачи; сам по себе не делает внешнее списание однократным |
| S15 | [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/) | Pub/Sub не является надёжным журналом для восстановления пропущенных заказов |
| S16 | [GitHub: protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | PR/review/checks и ограничения изменения защищённой ветки; доступность зависит от плана/типа репозитория |
| S17 | [GitHub: CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) | Назначение владельцев кода и review |
| S18 | [Git: worktree](https://git-scm.com/docs/git-worktree) | Несколько рабочих деревьев одного репозитория для независимых веток |
| S19 | [Electron: security](https://www.electronjs.org/docs/latest/tutorial/security) | Изоляция renderer, sandbox, защита IPC и ограничение навигации |

## Не подтверждено публичными источниками

Доступность Kaspi remote acquiring именно для PickChick; реализация конкретного банковского callback/refund API; актуальная закрытая спецификация Яндекс Еды для ресторана в Казахстане; выбранная ККМ и её локальный SDK; коммерческие тарифы; конфигурация моноблока/сервера; договорная схема чеков агрегатора; точные модели и версии AI-инструментов; сроки App Store/Google Play review.

Все эти пункты вынесены в реестр решений и ранние этапы roadmap. Номера API endpoint провайдеров, тарифы и обещания offline-эквайринга не выдумывались.

## Материалы заказчика

1. Пять HTML из текущего сообщения — первичный источник предполагаемых интерфейсов.
2. Текущее описание экосистемы — источник обязательного функционала и географии.
3. Текущее уточнение о четырёх месяцах — источник крайнего срока вместе с тестированием/внедрением.
4. Текущее уточнение о Fable/Astra — источник используемых командой названий моделей.
5. Доступное прежнее обсуждение «Техническое задание проекта» — дополнительный контекст RU/KZ, контента, 2D-игр и исторического коммерческого ориентира.

При расхождении HTML и прямого запроса приоритет имеет запрос; выявленные противоречия не считаются утверждёнными бизнес-правилами.
