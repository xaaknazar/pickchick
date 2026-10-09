/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { CustomerCheckout } from '../../packages/commerce-core/dist/index.js';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

// Requires an Expo web export with KASPI_CHECKOUT=1 and CUSTOMER_AUTH=server (the published
// catalog is the default; PUBLISHED_CATALOG=0 would select the legacy menu).
// Opt in explicitly; generic integration CI does not build this release-specific web artifact.
test(
  'live menu reprices basket within three seconds and preserves unavailable dishes for explicit removal',
  { skip: process.env.MOBILE_CATALOG_BROWSER !== '1' },
  async () => {
    await withSyncDatabases(async ({ cloud, org, legal, branch, device }) => {
      const pool = cloud.pool,
        customer = randomUUID(),
        account = randomUUID();
      const manager = await provisionCatalogManager(pool, {
        organization_id: org,
        name: 'Synthetic browser catalog director',
        branch_ids: [branch],
      });
      const legacy = new CatalogAdmin(pool, { enabled: true });
      let state = await legacy.seed(manager.token, branch, {
        expected_revision: 0,
        request_id: randomUUID(),
      });
      let payload = pricingFixture([
        product('burger', {
          name: { ru: 'Director Burger', kk: '' },
          price_minor: '245000',
          channel_prices_minor: { mobile: '255001' },
          image_asset_key: 'shot.jpg',
          modifier_groups: [
            group([
              option('extra', {
                label: { ru: 'Extra sauce', kk: '' },
                price_delta_minor: '15000',
                max_quantity: 2,
              }),
            ]),
          ],
        }),
        product('side', { name: { ru: 'Director Side', kk: '' }, price_minor: '25000' }),
      ]).publication.payload;
      const director = new CatalogAdmin(pool, { enabled: true, mobileStorefrontBranchId: branch });
      const publish = async () => {
        state = await director.save(manager.token, branch, {
          expected_revision: state.draft.revision,
          request_id: randomUUID(),
          payload,
        });
        state = await director.publish(manager.token, branch, {
          expected_revision: state.draft.revision,
          expected_published_version: state.published?.version ?? 0,
          request_id: randomUUID(),
          confirmation: 'publish_catalog',
        });
      };
      await publish();
      await pool.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [branch]);
      await pool.query("UPDATE devices SET status='active' WHERE id=$1", [device]);
      await pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [branch, org, device, randomUUID()],
      );
      await pool.query(
        "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
        [branch, device],
      );
      await pool.query(
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,'payment','kaspi-remote','synthetic-no-payment',true)",
        [account, org, branch, legal],
      );
      const checkout = new CustomerCheckout(pool, {
        organizationId: org,
        branchId: branch,
        paymentAccountId: account,
        customerIds: [customer],
        maxOrderMinor: '10000000',
        approvalReference: 'Synthetic approved pilot',
        publishedCatalogEnabled: true,
      });
      const quotes = [];
      let forbidden = 0;
      const web = fileURLToPath(new URL('../../.local/published-catalog-web/', import.meta.url));
      assert.ok(
        (await stat(web + '/index.html')).isFile(),
        'Export web with EXPO_PUBLIC_PUBLISHED_CATALOG=1 and EXPO_PUBLIC_KASPI_CHECKOUT=1 first',
      );
      const server = createServer(async (req, res) => {
        try {
          const path = new URL(req.url, 'http://localhost').pathname;
          if (path === '/fixture/publish') {
            payload = structuredClone(payload);
            payload.products[0].channel_prices_minor.mobile = '265001';
            payload.products = payload.products.filter((p) => p.id !== 'side');
            await publish();
            return res.end('{}');
          }
          if (path.startsWith('/v1/')) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            let value;
            if (path === '/v1/customer-checkout/catalog') value = await checkout.catalog();
            else if (path === '/v1/customer-checkout/catalog/media')
              value = await checkout.catalogMedia(
                new URL(req.url, 'http://localhost').searchParams.get('version'),
                { mediaEnabled: false },
              );
            else if (path === '/v1/customer-checkout/availability') {
              await pool.query(
                'UPDATE cloud_branch_availability SET observed_at=clock_timestamp()',
              );
              const state = await checkout.availabilityState();
              res.setHeader('X-Catalog-Version', String(state.catalogVersion));
              res.setHeader('Access-Control-Expose-Headers', 'X-Catalog-Version');
              value = state.body;
            } else if (path === '/v1/customer-checkout/config')
              value = await checkout.config(customer);
            else if (path === '/v1/customer-checkout/quotes' && req.method === 'POST') {
              assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64));
              let bytes = '';
              for await (const chunk of req) bytes += chunk;
              const body = JSON.parse(bytes);
              value = await checkout.quote(customer, body);
              quotes.push({ body, value });
            } else if (path === '/v1/customer-checkout/orders' && req.method === 'GET')
              value = { orders: [] };
            else {
              forbidden++;
              throw Object.assign(new Error('No order or payment allowed in this fixture'), {
                code: 'FORBIDDEN',
              });
            }
            return res.end(JSON.stringify(value));
          }
          const candidate = web + (path === '/' ? '/index.html' : path);
          const file = await stat(candidate)
            .then((s) => (s.isFile() ? candidate : web + '/index.html'))
            .catch(() => web + '/index.html');
          const extension = file.split('.').pop();
          res.setHeader(
            'Content-Type',
            {
              html: 'text/html',
              js: 'text/javascript',
              css: 'text/css',
              png: 'image/png',
              jpg: 'image/jpeg',
              woff2: 'font/woff2',
              ttf: 'font/ttf',
              svg: 'image/svg+xml',
            }[extension] ?? 'application/octet-stream',
          );
          res.end(await readFile(file));
        } catch (error) {
          res.statusCode = error.code === 'FORBIDDEN' ? 403 : 409;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              code: error.code ?? 'INTERNAL_ERROR',
              message_key: `errors.${(error.code ?? 'INTERNAL_ERROR').toLowerCase()}`,
              trace_id: randomUUID(),
              retryable: false,
            }),
          );
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}`;
      const output = fileURLToPath(
        new URL('../../.local/published-catalog-browser/', import.meta.url),
      );
      await mkdir(output, { recursive: true });
      const temp = await mkdtemp(output + '/run-');
      try {
        const fixture = temp + '/fixture.json';
        await writeFile(fixture, JSON.stringify({ url, branch, customer, output }), {
          mode: 0o600,
        });
        const code = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [
              fileURLToPath(new URL('../mobile/browser_published_catalog.py', import.meta.url)),
              fixture,
            ],
            { stdio: 'inherit' },
          );
          child.on('error', reject);
          child.on('exit', resolve);
        });
        assert.equal(code, 0);
        assert.equal(quotes.length, 2);
        assert.equal(quotes[0].body.catalog_version, 1);
        assert.equal(quotes[0].value.totalMinor, '540002');
        assert.equal(quotes[1].body.catalog_version, 2);
        assert.equal(quotes[1].value.totalMinor, '560002');
        for (const table of ['commerce_orders', 'commerce_payment_attempts', 'commerce_outbox'])
          assert.equal(
            (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
            0,
            table,
          );
        assert.ok(forbidden <= 2);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(temp, { recursive: true, force: true });
      }
    });
  },
);
