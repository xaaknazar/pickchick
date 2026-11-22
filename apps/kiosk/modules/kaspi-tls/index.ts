import { requireOptionalNativeModule } from 'expo';
import type { KaspiTlsNative } from '../../src/kaspi-terminal';

/**
 * Native half of the kiosk's HTTPS to its Kaspi Smart POS (ADR-0018 point 1, Swift in
 * ios/KaspiTlsModule.swift): URLSession that accepts the terminal's self-signed certificate only
 * when the SHA-256 of its leaf equals the stored pin. iOS only. Web, Android, Node tests and
 * builds made before it get null; `kaspiTlsFrom` (src/kaspi-terminal.ts) then reports HTTPS as
 * unsupported and nothing is sent.
 */
export const KaspiTlsModule = requireOptionalNativeModule<KaspiTlsNative>('KaspiTls');
