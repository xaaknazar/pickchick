import { z } from 'zod';
export const NotificationLocaleSchema = z.enum(['ru', 'kk', 'en']);
export const NotificationPreferencesSchema = z.strictObject({
  locale: NotificationLocaleSchema,
  orders: z.boolean(),
  promotions: z.boolean(),
});
export const NotificationPreferencePatchSchema = NotificationPreferencesSchema.partial()
  .extend({
    consentVersion: z.literal('notifications-v1').optional(),
  })
  .refine((v) => v.promotions !== true || v.consentVersion === 'notifications-v1');
export const PushDeviceSchema = z
  .strictObject({
    installationId: z.uuid(),
    provider: z.enum(['apns', 'fcm']),
    environment: z.enum(['development', 'production']),
    token: z
      .string()
      .min(32)
      .max(4096)
      .regex(/^[A-Za-z0-9:_-]+$/),
    bundleId: z.enum(['kz.pickchick.app', 'kz.pickchick.app.dev']),
  })
  .refine((v) => v.provider !== 'apns' || /^[a-fA-F0-9]{64}$/.test(v.token));
export const NotificationKindSchema = z.enum(['paid', 'preparing', 'ready', 'handed_over']);
export const CustomerNotificationSchema = z.strictObject({
  id: z.uuid(),
  orderId: z.uuid(),
  kind: NotificationKindSchema,
  title: z.string().max(160),
  body: z.string().max(500),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export const NotificationInboxSchema = z.strictObject({
  items: z.array(CustomerNotificationSchema).max(100),
});
export const NotificationConfigSchema = z.strictObject({
  enabled: z.boolean(),
  providers: z.array(z.enum(['apns', 'fcm'])),
  consentVersion: z.literal('notifications-v1'),
});
