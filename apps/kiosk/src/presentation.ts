export function kioskOrderNumber(number: string | null | undefined): string {
  if (!number || number === '-') return '-';
  return `№${number.replace(/^№\s*/, '')}`;
}

/** The big number on the order screen: the design shows it bare ("152"), without "№". */
export function kioskTicketNumber(number: string | null | undefined): string {
  if (!number || number === '-') return '-';
  return number.replace(/^№\s*/, '');
}

export function qrScanInstructions(locale: string): string {
  return locale === 'ru'
    ? 'Откройте Kaspi.kz и отсканируйте QR. Результат проверяется автоматически.'
    : 'Kaspi.kz қосымшасын ашып, QR сканерлеңіз. Нәтиже автоматты түрде тексеріледі.';
}
