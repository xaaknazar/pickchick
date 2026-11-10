// Bot API sendMessage. The token is part of the URL, so neither the URL, the request nor
// the response body is ever logged or rethrown; failures surface only as short codes.

export class TelegramDeliveryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function transportFailure(error) {
  return new TelegramDeliveryError(
    error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'TELEGRAM_TIMEOUT'
      : 'TELEGRAM_UNREACHABLE',
  );
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
    throw transportFailure(error);
  }
  const body = await response.json().catch((error) => {
    if (error instanceof SyntaxError) return null;
    // Reading the body uses the same timeout signal as the initial fetch.
    throw transportFailure(error);
  });
  if (!response.ok || body?.ok !== true)
    throw new TelegramDeliveryError(
      `TELEGRAM_HTTP_${Number.isInteger(response.status) ? response.status : 0}`,
    );
}
