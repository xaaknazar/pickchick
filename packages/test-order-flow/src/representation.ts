import { z } from 'zod';
import {
  TEST_CATALOG_VERSION,
  TEST_COMPLETE_CATALOG_VERSION,
  TestLegacyCatalogSchema,
  TestLegacyQuoteSchema,
  TestLineSchema,
  TestProductSchema,
  type TestQuote,
} from './contracts.js';

/** A rollout adapter only; immutable PostgreSQL snapshots retain their original version. */
export function legacyTestQuote(quote: TestQuote): z.infer<typeof TestLegacyQuoteSchema> {
  if (quote.catalog_version === TEST_CATALOG_VERSION) return quote;
  return TestLegacyQuoteSchema.parse({
    synthetic: quote.synthetic,
    namespace: quote.namespace,
    quote_id: quote.quote_id,
    branch_id: quote.branch_id,
    catalog_version: TEST_CATALOG_VERSION,
    channel: quote.channel,
    service_mode: quote.service_mode,
    currency: quote.currency,
    total_minor: quote.total_minor,
    created_at: quote.created_at,
    expires_at: quote.expires_at,
    lines: quote.lines.map((line) => {
      const choices = line.selections
        .map(
          (selection) =>
            `${selection.group_label}: ${selection.option_label}${selection.quantity > 1 ? ` × ${selection.quantity}` : ''}`,
        )
        .join('; ');
      return TestLineSchema.parse({
        id: line.line_id,
        name: choices ? `${line.name} (${choices})` : line.name,
        description: line.description,
        category: line.category,
        price_minor: line.price_minor,
        image_id: line.image_id,
        prep_required: line.prep_required,
        quantity: line.quantity,
        line_total_minor: line.line_total_minor,
      });
    }),
  });
}

export function legacyTestResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (data['catalog_version'] === TEST_COMPLETE_CATALOG_VERSION) {
    if (Array.isArray(data['lines'])) return legacyTestQuote(data as TestQuote);
    if (Array.isArray(data['products'])) {
      return TestLegacyCatalogSchema.parse({
        synthetic: data['synthetic'],
        namespace: data['namespace'],
        branch_id: data['branch_id'],
        catalog_version: TEST_CATALOG_VERSION,
        currency: data['currency'],
        products: data['products'].map((product: Record<string, unknown>) =>
          TestProductSchema.parse(
            Object.fromEntries(
              Object.keys(TestProductSchema.shape).map((key) => [key, product[key]]),
            ),
          ),
        ),
      });
    }
  }
  if (data['snapshot'])
    return { ...data, snapshot: legacyTestQuote(data['snapshot'] as TestQuote) };
  if (Array.isArray(data['orders']))
    return { ...data, orders: data['orders'].map(legacyTestResponse) };
  return value;
}
