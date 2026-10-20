import { CapabilitiesSchema } from '@pickchick/contracts';
import type { ServiceConfig } from '@pickchick/platform';

/**
 * Public `GET /v1/capabilities`, schema v1.
 *
 * The v1 booleans (`ordering_enabled`, `checkout`, `payments`, `fiscal`, `loyalty`) are a frozen
 * compatibility gate, not a description of production: installed mobile builds (TestFlight 0.2.0
 * build 20) and kiosk builds refuse to load the catalog unless every one of them is `false`
 * (apps/mobile/src/api.ts parseCapabilities, apps/kiosk/src/controller.ts loadCatalog). Real
 * mobile Kaspi payments run behind the customer checkout routes since 30.09.2026; the facts live
 * in docs/architecture/api-capabilities.md. Only the human-readable notice follows the
 * configuration, and no installed client renders it.
 */
export function capabilityNotice(customerAuth: boolean, env: NodeJS.ProcessEnv) {
  if (!customerAuth)
    return {
      ru: 'Тестовый стенд PickChick. Доступен только синтетический TEST-сценарий при включённом тестовом режиме. Реальные заказы, SMS, платежи и чеки недоступны.',
      kk: 'PickChick сынақ ортасы. Сынақ режимі қосылғанда тек синтетикалық TEST сценарийі қолжетімді. Нақты тапсырыстар, SMS, төлемдер мен чектер қолжетімсіз.',
    };
  // CUSTOMER_KASPI_SALES_ENABLED=false is the owner's switch for new mobile Kaspi payments.
  if (env.CUSTOMER_KASPI_PILOT_ENABLED === 'true' && env.CUSTOMER_KASPI_SALES_ENABLED !== 'false')
    return {
      ru: 'Заказы в приложении оплачиваются через Kaspi. Чеки в процессе подключения.',
      kk: 'Қосымшадағы тапсырыстар Kaspi арқылы төленеді. Чектер қосылуда.',
    };
  return {
    ru: 'Заказы в ресторане доступны без оплаты. Оплата и чеки в процессе подключения.',
    kk: 'Мейрамханаға тапсырыстар төлемсіз қолжетімді. Төлем мен чектер қосылуда.',
  };
}

export function capabilities(config: ServiceConfig, env: NodeJS.ProcessEnv = process.env) {
  return CapabilitiesSchema.parse({
    schema_version: 1,
    environment: config.environment,
    data_mode: config.customerAuthEnabled ? 'pilot' : 'synthetic',
    ordering_enabled: false,
    features: {
      phone_auth: config.customerAuthEnabled === true,
      checkout: false,
      payments: false,
      fiscal: false,
      loyalty: false,
      test_order_flow: config.testOrderFlowEnabled === true,
      unpaid_test_orders: config.testOrderFlowEnabled === true,
    },
    notice: capabilityNotice(config.customerAuthEnabled === true, env),
  });
}
