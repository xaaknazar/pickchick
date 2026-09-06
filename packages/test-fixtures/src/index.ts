import { MenuSnapshotSchema } from '@pickchick/contracts';

export const fixtureIds = {
  organization: '10000000-0000-4000-8000-000000000001',
  legalEntity: '10000000-0000-4000-8000-000000000002',
  branch: '10000000-0000-4000-8000-000000000003',
  device: '10000000-0000-4000-8000-000000000004',
  category: '10000000-0000-4000-8000-000000000005',
  product: '10000000-0000-4000-8000-000000000006',
  variant: '10000000-0000-4000-8000-000000000007',
  release: '10000000-0000-4000-8000-000000000008',
} as const;

export const fixtureBranch = {
  id: fixtureIds.branch,
  code: 'TEST-ALMATY-01',
  name: 'Тестовая точка — не ресторан',
  timezone: 'Asia/Almaty' as const,
  ordering_enabled: false,
};

export const fixtureMenu = MenuSnapshotSchema.parse({
  schema_version: 1,
  release_id: fixtureIds.release,
  branch_id: fixtureIds.branch,
  version: 1,
  published_at: '2026-09-06T00:00:00Z',
  items: [
    {
      product_id: fixtureIds.product,
      variant_id: fixtureIds.variant,
      category_id: fixtureIds.category,
      name: { ru: 'Тестовая порция', kk: 'Сынақ порциясы' },
      price_minor: '349000',
      currency: 'KZT',
    },
  ],
});
