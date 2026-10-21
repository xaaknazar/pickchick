// Bot API sendMessage. The token is part of the URL, so neither the URL, the request nor
// the response body is ever logged or rethrown; failures surface only as short codes.

export class TelegramDeliveryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function sendTelegram({ token, chatId }, text, fetcher = fetch, timeoutMs = 10_000) {
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TelegramDeliveryError(
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'TELEGRAM_TIMEOUT'
        : 'TELEGRAM_UNREACHABLE',
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true)
    throw new TelegramDeliveryError(
      `TELEGRAM_HTTP_${Number.isInteger(response.status) ? response.status : 0}`,
    );
}
