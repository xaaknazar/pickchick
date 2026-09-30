# BO-02: визуальная проверка

8 сентября 2026. Реальный клиент + HTTP + временные PostgreSQL schemas.
Никаких production-данных или токенов в изображениях.

Просмотрены dashboard и склад на 1680×1040 и 1024×768. Проверены порядок
15 разделов, 250 px sidebar, Inter, тёмные панели, оранжевые действия,
период/точка/обновление, таблицы и отсутствие переполнения. Сравнение с
оригиналом владельца: `../original-catalog-1680.png`, источник и SHA в provenance.
Это ручная проверка композиции, не заявление о pixel-perfect совпадении
каждой формы исходного offline demo.

`promotion-393.png`: мобильное промо из настоящей BO-публикации; прочие
каталог/логин запросы в мобильном browser-сценарии используют локальные fixtures.
Проверены 3 прямые ссылки на выключенные игры и отсутствие карточек в событиях.

Повтор: `BACKOFFICE_TEST_PYTHON=/path/to/python pnpm test:backoffice`.
Для mobile после web export запустить локальный preview и
`MOBILE_RECOVERY_URL=http://127.0.0.1:PORT BACKOFFICE_TEST_PYTHON=/path/to/python node --env-file=.env tests/backoffice/content-browser.mjs`.
