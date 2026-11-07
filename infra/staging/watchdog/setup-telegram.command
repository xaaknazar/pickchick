#!/bin/bash
# Owner runs this only AFTER the verified stage2 window. Never paste the token in chat.
set -euo pipefail
set +x
umask 077
cd -- "$(dirname -- "$0")"
printf '%s\n' 'После успешного серверного окна. Старый токен нужно отозвать в BotFather.'
read -r -p 'Окно завершено и проверено? Введите ГОТОВО: ' watchdog_confirmation
[ "$watchdog_confirmation" = 'ГОТОВО' ] || exit 1
read -r -s -p 'Новый токен Telegram (ввод скрыт): ' watchdog_secret
printf '\n'
trap 'unset watchdog_secret' EXIT
printf '%s\n' "$watchdog_secret" | python3 setup-telegram.py --ssh-key "$HOME/.ssh/pickchick_staging_ed25519" --server-window-verified --apply
unset watchdog_secret
