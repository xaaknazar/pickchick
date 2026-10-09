import { z } from 'zod';

/** Device access has its own transport. No financial or fulfillment command can enter it. */
export const TerminalModeSchema = z.enum(['prep', 'assembly', 'display']);
export type TerminalMode = z.infer<typeof TerminalModeSchema>;
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().positive().max(2147483646);
export const DeviceAccessCommandSchema = z
  .strictObject({
    commandId: uuid,
    branchId: uuid,
    edgeDeviceId: uuid,
    terminalId: uuid,
    mode: TerminalModeSchema,
    name: z.string().trim().min(1).max(120),
    generation,
    action: z.enum(['pair', 'revoke']),
    codeHash: hash.nullable(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine((v) => (v.action === 'pair') === (v.codeHash !== null))
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.parse(v.issuedAt) &&
      Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= 600_000,
  );
export type DeviceAccessCommand = z.infer<typeof DeviceAccessCommandSchema>;
export const DeviceAccessReceiptSchema = z.strictObject({
  commandId: uuid,
  terminalId: uuid,
  generation,
  state: z.enum(['applied', 'paired', 'expired', 'rejected']),
});
export type DeviceAccessReceipt = z.infer<typeof DeviceAccessReceiptSchema>;
/** Resets only the existing shared kitchen identity. Never creates staff or changes PINs. */
export const KitchenPasswordResetCommandSchema = z
  .strictObject({
    commandId: uuid,
    branchId: uuid,
    edgeDeviceId: uuid,
    login: z.literal('kitchen'),
    codeHash: hash,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.parse(v.issuedAt) &&
      Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= 600_000,
  );
export type KitchenPasswordResetCommand = z.infer<typeof KitchenPasswordResetCommandSchema>;
export const KitchenPasswordResetReceiptSchema = z.strictObject({
  commandId: uuid,
  state: z.enum(['applied', 'used', 'expired', 'rejected']),
});
export type KitchenPasswordResetReceipt = z.infer<typeof KitchenPasswordResetReceiptSchema>;
export const DeviceAccessExchangeSchema = z.strictObject({
  protocolVersion: z.literal(1),
  receipts: z.array(DeviceAccessReceiptSchema).max(50),
  resetReceipts: z.array(KitchenPasswordResetReceiptSchema).max(50).default([]),
});
export const DeviceAccessExchangeResponseSchema = z.strictObject({
  branchId: uuid,
  edgeDeviceId: uuid,
  commands: z.array(DeviceAccessCommandSchema).max(25),
  acknowledged: z.array(DeviceAccessReceiptSchema).max(50),
  resetCommands: z.array(KitchenPasswordResetCommandSchema).max(25).default([]),
  resetAcknowledged: z.array(KitchenPasswordResetReceiptSchema).max(50).default([]),
});
// 128 random bits, grouped for manual entry. A hash does not make a short numeric code safe.
export const TerminalPairRequestSchema = z.strictObject({
  mode: TerminalModeSchema.optional(),
  code: z
    .string()
    .max(39)
    .transform((v) => v.replaceAll('-', '').toLowerCase())
    .pipe(z.string().regex(/^[a-f0-9]{32}$/)),
});
export const TerminalCredentialSchema = z.strictObject({
  terminalId: uuid,
  branchId: uuid,
  mode: TerminalModeSchema,
  generation,
  terminalKey: hash,
});
export type TerminalCredential = z.infer<typeof TerminalCredentialSchema>;
