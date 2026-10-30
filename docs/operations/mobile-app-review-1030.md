# App Review 5.1.1(v): подготовка видео и повторной проверки

Apple отклонила 30.10 карточку 1.0 со сборкой 0.2.0 (23): не найдена функция
удаления аккаунта. Других замечаний в сообщении нет. Проверяли на iPad Air
11-inch (M3). [Сообщение](https://appstoreconnect.apple.com/apps/6809208492/distribution/reviewsubmissions/details/99775be3-3644-4d17-8e4f-ab4dfe3e53ca).

## Изменения для сборки 32

Продолжение своей задачи mobile-kazakh-review-1030 в отдельном worktree.
В профиле рядом с языком прямо указано «Удалить аккаунт»; такой же пункт
есть в настройках. Экран имеет тот же заголовок. Это переход к управлению,
а не немедленное удаление: подтверждение и возможность оставить аккаунт
сохранены. Успех отображается только после успешного ответа сервера.
Вкладка «Игры» получила контурный геймпад вместо календаря. Маршрут events,
размеры, озвучиваемая подпись, состояния вкладки и платежи сохранены.
Использованы существующие переводы RU/KK/EN, системный шрифт kk из31 сохранён.

## Видео владельца на физическом iPhone

Используйте выделенный проверочный аккаунт Apple, а не личный аккаунт
с заказами. Не показывайте пароль, код входа или личные уведомления.

1. Обновить PickChick в TestFlight до подготовленной новой сборки32 после
   подтверждения доступности. Выбрать английский язык для проверяющего.
2. Начать запись экрана. Войти в выделенный аккаунт Apple; не записывать
   ввод секретного кода. Показать успешный вход и открытый профиль.
3. В профиле нажать Delete account. Показать экран с описанием последствий.
4. Нажать Delete account на экране, затем показать подтверждение.
5. Самостоятельно подтвердить удаление выделенного проверочного аккаунта.
6. Дождаться Account deleted. Не заменять завершение выходом из аккаунта
   или очисткой локальных данных. Остановить запись.
7. Перед отправкой Apple снова войти выделенными проверочными данными,
   чтобы аккаунт был доступен для проверки. Код и номер в Git не сохранять.

Apple требует запись физического устройства с входом, переходом к функции
и полным удалением до подтверждения. Симулятор и браузерные тесты не заменяют
это доказательство. Не создавать заказы, счета или платежи для видео.
Если вход или удаление завершатся ошибкой, сохранить текст ошибки без секретов;
не утверждать Apple, что сценарий завершён.

## App Review Notes: точный путь (черновик)

ACCOUNT DELETION
After signing in with the dedicated review credentials, open Profile using
the profile button at the top of Menu, Games or Orders. Tap Delete account
in the profile list (below Language). On the Delete account screen, tap
Delete account and confirm in the confirmation dialog. Wait for Account deleted.
The same entry is also available in Profile > Settings > Delete account.
This deletes the server account; Clear local data is a different action.
The dedicated review credentials can be used to create a fresh review profile.

PHYSICAL DEVICE RECORDING
Attach the owner's completed physical-device recording before resubmission.
Do not submit this placeholder as a video link or claim that a recording exists.

## Ответ Apple после проверки видео (черновик, не отправлен)

Thank you for the review. We have made account deletion directly visible in
Profile and Settings, with an explicit confirmation after successful deletion.
The path is Profile > Delete account > Delete account > confirm.
We will provide the requested physical-device recording showing sign-in and
the complete deletion flow, and include it in App Review Notes.

## Границы готовности

Новый бинарник, проверки и доступность TestFlight фиксируются отдельно в
[протоколе32](mobile-testflight32.md). Видео пока не получено, ответ Apple
и повторная отправка не выполнены. Сервер и данные не изменяются в этой работе.
