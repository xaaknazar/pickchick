const unavailable = 'Локальный сервер кассы ещё не готов. Подождите и повторите вход.';
export async function requestPinCredential(
  pin,
  terminalId,
  {
    fetchImpl = globalThis.fetch,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let ready = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl('/health/ready', { signal: AbortSignal.timeout(2000) });
      const status = response.ok ? await response.json() : null;
      ready = status?.ready === true;
    } catch {
      /* A local server may still be starting. No PIN is sent during probes. */
    }
    if (ready) break;
    if (attempt < 2) await pause(500);
  }
  if (!ready) throw new Error(unavailable);
  let response;
  try {
    response = await fetchImpl('/edge/v1/staff/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, terminal_id: terminalId }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error(unavailable);
  }
  if (!response.ok) {
    if (response.status === 429) {
      // After repeated wrong PINs the edge locks PIN login on this terminal for up to 15 min.
      const seconds = Number(response.headers?.get?.('retry-after'));
      if (Number.isInteger(seconds) && seconds > 60)
        throw new Error(
          `Вход по PIN временно заблокирован после неверных попыток. Повторите через ${Math.ceil(seconds / 60)} мин.`,
        );
      throw new Error('Подождите минуту перед следующим входом');
    }
    if ([401, 403].includes(response.status))
      throw new Error('Неверный PIN или нет доступа к рабочему месту');
    throw new Error(unavailable);
  }
  return response.json();
}
