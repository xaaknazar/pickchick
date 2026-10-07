import qrcode from 'qrcode-generator';
// Both the ESM and CommonJS encoder use this hook; preserve Unicode payloads.
qrcode.stringToBytes = (value: string) =>
  (encodeURIComponent(value).match(/%[0-9A-F]{2}|./g) ?? []).map((part) =>
    part.startsWith('%') ? Number.parseInt(part.slice(1), 16) : part.charCodeAt(0),
  );
/** Encode the exact bank payload locally; no payload reaches an image service. */
export function paymentQrSvg(payload: string): string | null {
  if (!payload || payload.length > 4096) return null;
  try {
    const code = qrcode(0, 'M');
    code.addData(payload, 'Byte');
    code.make();
    const count = code.getModuleCount();
    const cells: string[] = [];
    for (let y = 0; y < count; y++)
      for (let x = 0; x < count; x++)
        if (code.isDark(y, x)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count + 8} ${count + 8}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${count + 8}v${count + 8}H0z"/><path fill="#000" d="${cells.join('')}"/></svg>`;
  } catch {
    return null;
  }
}

export function visiblePaymentQr(
  payment: { state: string; qrPayload: string | null; expiresAt: string | null } | null | undefined,
  unknown: boolean,
  now: number,
): string | null {
  if (
    unknown ||
    payment?.state !== 'pending' ||
    !payment.qrPayload ||
    !payment.expiresAt ||
    !Number.isFinite(Date.parse(payment.expiresAt)) ||
    Date.parse(payment.expiresAt) <= now
  )
    return null;
  return payment.qrPayload;
}
