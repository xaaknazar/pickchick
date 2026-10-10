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
import { CatalogPublicationListener } from '../../services/api/dist/catalog-publication-listener.js';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

// Live menu update through the real availability long-poll (CustomerCheckoutController with the
// real LISTEN connection) and CatalogAdmin.publish on the local PostgreSQL, observed by the web
// client without any user action. Requires the same Expo web export as
// catalog-mobile-browser.test.mjs (KASPI_CHECKOUT=1, CUSTOMER_AUTH=server); opt in explicitly.
// The fixture refuses every order, quote or payment command.
test(
  'open card and cart follow a publication within three seconds, across background and network loss',
  { skip: process.env.MOBILE_CATALOG_BROWSER !== '1' },
  async () => {
    await withSyncDatabases(async ({ cloud, org, legal, branch, device }) => {
      const pool = cloud.pool,
        customer = randomUUID(),
        account = randomUUID();
      const manager = await provisionCatalogManager(pool, {
        organization_id: org,
        name: 'Synthetic live browser director',
        branch_ids: [branch],
      });
      let state = await new CatalogAdmin(pool, { enabled: true }).seed(manager.token, branch, {
        expected_revision: 0,
        request_id: randomUUID(),
      });
      let payload = pricingFixture([
        product('burger', {
          name: { ru: 'Director Burger', kk: '' },
          price_minor: '245000',
          channel_prices_minor: { mobile: '255001' },
          modifier_groups: [
            group([
              option('extra', {
                label: { ru: 'Extra sauce', kk: '' },
                price_delta_minor: '15000',
                max_quantity: 2,
              }),
              option('mild', {
                label: { ru: 'Mild sauce', kk: '' },
                price_delta_minor: '0',
                max_quantity: 2,
              }),
            ]),
          ],
        }),
        product('side', { name: { ru: 'Director Side', kk: '' }, price_minor: '25000' }),
      ]).publication.payload;
      const director = new CatalogAdmin(pool, { enabled: true, mobileStorefrontBranchId: branch });
      const publications = [];
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
        publications.push(state.published.version);
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
      const listener = new CatalogPublicationListener({ pool });
      await listener.onModuleInit();
      const controller = new CustomerCheckoutController(
        { me: async () => assert.fail('identity is not used by the storefront reads') },
        { pool },
        listener,
      );
      controller.checkout = checkout;
      let refused = 0;
      const web = fileURLToPath(new URL('../../.local/published-catalog-web/', import.meta.url));
      assert.ok(
        (await stat(web + '/index.html')).isFile(),
        'Export web with EXPO_PUBLIC_KASPI_CHECKOUT=1 and EXPO_PUBLIC_CUSTOMER_AUTH=server first',
      );
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost'),
            path = url.pathname;
          if (path === '/fixture/publish' && req.method === 'POST') {
            payload = structuredClone(payload);
            const price = url.searchParams.get('price');
            if (price) payload.products[0].channel_prices_minor.mobile = price;
            if (url.searchParams.get('drop_option') === 'extra')
              payload.products[0].modifier_groups[0].options =
                payload.products[0].modifier_groups[0].options.filter((o) => o.id !== 'extra');
            await publish();
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ version: state.published.version }));
          }
          if (path.startsWith('/v1/')) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            let value;
            if (path === '/v1/customer-checkout/catalog' && req.method === 'GET')
              value = await checkout.catalog();
            else if (path === '/v1/customer-checkout/catalog/media' && req.method === 'GET')
              value = await checkout.catalogMedia(url.searchParams.get('version'), {
                mediaEnabled: false,
              });
            else if (path === '/v1/customer-checkout/availability' && req.method === 'GET') {
              await pool.query(
                'UPDATE cloud_branch_availability SET observed_at=clock_timestamp()',
              );
              // The real long-poll: NOTIFY wake-up, shared reads and the 2 s fallback.
              value = await controller.availability(
                res,
                url.searchParams.get('after') ?? undefined,
              );
              if (res.destroyed) return;
            } else if (path === '/v1/customer-checkout/config' && req.method === 'GET')
              value = await checkout.config(customer);
            else if (path === '/v1/customer-checkout/orders' && req.method === 'GET')
              value = { orders: [] };
            else {
              refused++;
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
          if (res.destroyed) return;
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
      const output = fileURLToPath(new URL('../../.local/live-menu-browser/', import.meta.url));
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
              fileURLToPath(new URL('../mobile/browser_live_menu_update.py', import.meta.url)),
              fixture,
            ],
            { stdio: 'inherit' },
          );
          child.on('error', reject);
          child.on('exit', resolve);
        });
        assert.equal(code, 0);
        assert.deepEqual(publications, [1, 2, 3, 4, 5]);
        assert.equal(refused, 0);
        for (const table of ['commerce_orders', 'commerce_payment_attempts', 'commerce_outbox'])
          assert.equal(
            (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
            0,
            table,
          );
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await listener.onModuleDestroy();
        await rm(temp, { recursive: true, force: true });
      }
    });
  },
);
