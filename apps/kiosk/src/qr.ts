import qrcode from 'qrcode-generator';
// Both the ESM and CommonJS encoder use this hook; preserve Unicode payloads.
qrcode.stringToBytes = (value: string) =>
  (encodeURIComponent(value).match(/%[0-9A-F]{2}|./g) ?? []).map((part) =>
    part.startsWith('%') ? Number.parseInt(part.slice(1), 16) : part.charCodeAt(0),
  );
/**
 * Encode the exact bank payload locally; no payload reaches an image service. `quiet` is the
 * white margin in modules (4 by the standard); a smaller one is only for a code drawn on a white
 * plate whose own padding completes the 4 modules.
 */
export function paymentQrSvg(payload: string, quiet = 4): string | null {
  if (!payload || payload.length > 4096 || !Number.isInteger(quiet) || quiet < 0 || quiet > 4)
    return null;
  try {
    const code = qrcode(0, 'M');
    code.addData(payload, 'Byte');
    code.make();
    const count = code.getModuleCount();
    const cells: string[] = [];
    for (let y = 0; y < count; y++)
      for (let x = 0; x < count; x++)
        if (code.isDark(y, x)) cells.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    const side = count + quiet * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${side}v${side}H0z"/><path fill="#000" d="${cells.join('')}"/></svg>`;
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

/** Modules per side of the code for `payload`, without a quiet zone; 0 when it cannot be encoded. */
export function paymentQrModules(payload: string): number {
  const svg = paymentQrSvg(payload, 0);
  return svg ? Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 0) : 0;
}

/**
 * Quiet zone (in modules) of a code `fit` points wide on a white plate with `padding` points of
 * its own: the smallest that still leaves the standard 4 modules of white around the code, with
 * modules snapped to whole points as PaymentQR draws them.
 */
export function plateQuietZone(modules: number, fit: number, padding: number): number {
  if (!modules) return 4;
  for (let quiet = 0; quiet < 4; quiet++) {
    const module = Math.max(1, Math.round(fit / (modules + quiet * 2)));
    if (padding + quiet * module >= 4 * module) return quiet;
  }
  return 4;
}
