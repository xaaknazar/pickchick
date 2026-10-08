import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';

const sharp = createRequire(new URL('../../packages/catalog-admin/package.json', import.meta.url))(
  'sharp',
);

test('unified menu UI: real photo upload and publish, cashier delivery badge, stop toggle pending to applied, analyst view', () =>
  withCatalog(
    async (ctx) => {
      const output = new URL('../../.local/backoffice-unified-menu/', import.meta.url);
      await mkdir(output, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
      const photo = temp + '/fixture.jpg';
      const bigPhoto = temp + '/big-photo.jpg';
      const fixture = temp + '/fixture.json';
      try {
        // Synthetic fixture photo, larger than the card rendition so re-encoding is visible.
        await writeFile(
          photo,
          await sharp({
            create: { width: 1200, height: 900, channels: 3, background: '#d9480f' },
          })
            .composite([
              {
                input: Buffer.from(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><circle cx="600" cy="450" r="300" fill="#ffd43b"/></svg>',
                ),
              },
            ])
            .jpeg({ quality: 85 })
            .toBuffer(),
        );
        // A detailed phone-sized photo, far above the 300 KB staff-portal body limit.
        await writeFile(
          bigPhoto,
          await sharp({
            create: {
              width: 2400,
              height: 1800,
              channels: 3,
              background: '#7a4b2a',
              noise: { type: 'gaussian', mean: 128, sigma: 40 },
            },
          })
            .blur(6)
            .jpeg({ quality: 95 })
            .toBuffer(),
        );
        await writeFile(
          fixture,
          JSON.stringify({
            url: ctx.url + '/backoffice/',
            manager: ctx.manager,
            branch: ctx.branch,
            photo,
            big_photo: bigPhoto,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const exit = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('unified_menu_ui.py', import.meta.url)), fixture],
            { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
          );
          const timer = setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }, 150000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve(signal ? signal : code);
          });
        });
        assert.equal(exit, 0, 'Unified menu browser flow must pass');
        // The published menu carries the uploaded photo reference and the kitchen route.
        const published = await ctx.service.publicCatalog(ctx.branch);
        assert.equal(published.version, 1);
        const withPhoto = published.payload.products.filter((p) => p.image);
        assert.equal(withPhoto.length, 1);
        const [product] = withPhoto;
        assert.equal(product.image_asset_key, 'i8.jpg');
        assert.equal(product.kitchen_route, 'assembly_item');
        assert.equal(product.image.tile_color, '#FF6600');
        assert.equal(product.image.cutout, true);
        const asset = (
          await ctx.cloud.pool.query(
            `SELECT a.id, v.sha256 FROM catalog_assets a
             JOIN catalog_asset_variants v ON v.asset_id=a.id AND v.variant='card'`,
          )
        ).rows;
        assert.equal(asset.length, 1, 'exactly one stored photo (rejected uploads store nothing)');
        assert.equal(product.image.asset_id, asset[0].id);
        assert.equal(product.image.sha256, asset[0].sha256);
        // The mocked stop list never reached the API: no command was queued.
        assert.equal(
          (await ctx.cloud.pool.query('SELECT count(*)::int n FROM cloud_stop_commands')).rows[0].n,
          0,
        );
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice', media: true, remoteStops: true },
  ));
