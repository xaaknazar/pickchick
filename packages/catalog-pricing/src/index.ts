import type { DatabasePool } from '@pickchick/database';
import { CartInputSchema, CatalogPricingError, PricingScopeSchema } from './model.js';
import type { PricingScope, PricedCatalogQuote } from './model.js';
import { priceCatalogSnapshot } from './pricing.js';
export * from './model.js';
export * from './pricing.js';

/** Reads only the currently published catalog. No draft, TEST catalog, issuance, or HTTP effects. */
export class CatalogPricing {
  constructor(private readonly pool: Pick<DatabasePool, 'query'>) {}
  async price(trustedScope: PricingScope, input: unknown): Promise<PricedCatalogQuote> {
    const scope = PricingScopeSchema.safeParse(trustedScope),
      cart = CartInputSchema.safeParse(input);
    if (!scope.success) throw new CatalogPricingError('SCOPE_MISMATCH');
    if (!cart.success) throw new CatalogPricingError('INVALID_CART');
    const row = (
      await this.pool.query<{
        organization_id: string;
        branch_id: string;
        ordering_enabled: boolean;
        version: number;
        payload_hash: string;
        payload: unknown;
        published_at: Date;
      }>(
        `SELECT b.organization_id,b.id AS branch_id,b.ordering_enabled,p.version,p.payload_hash,p.payload,p.published_at
        FROM branches b JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id
        JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version
        WHERE b.id=$1 AND b.organization_id=$2`,
        [scope.data.branchId, scope.data.organizationId],
      )
    ).rows[0];
    if (!row) throw new CatalogPricingError('CATALOG_NOT_FOUND');
    return priceCatalogSnapshot(
      {
        reference: {
          organizationId: row.organization_id,
          branchId: row.branch_id,
          version: row.version,
          payloadHash: row.payload_hash,
          publishedAt: row.published_at.toISOString(),
        },
        orderingEnabled: row.ordering_enabled,
        payload: row.payload,
      },
      scope.data,
      cart.data,
    );
  }
}

export { CatalogMobileStorefrontSchema } from '@pickchick/catalog-admin/contracts';
