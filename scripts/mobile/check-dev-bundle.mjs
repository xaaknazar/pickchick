import assert from 'node:assert/strict';

// Validate the running Dev server, whose watched file map differs from a fresh export.
const origin = new URL(process.env.MOBILE_DEV_URL ?? 'http://127.0.0.1:8081');
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
assert.ok(!origin.username && !origin.password);
const platform = process.env.MOBILE_DEV_PLATFORM ?? 'ios';
assert.ok(['ios', 'android'].includes(platform));

const manifestResponse = await fetch(new URL('/', origin), {
  headers: {
    accept: 'application/expo+json',
    'expo-platform': platform,
    'expo-protocol-version': '0',
    'expo-dev-client': 'true',
  },
  redirect: 'error',
  signal: AbortSignal.timeout(15_000),
});
assert.ok(manifestResponse.ok, `Dev manifest returned HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
const bundle = new URL(manifest.launchAsset.url);
assert.equal(bundle.origin, origin.origin);
assert.ok(bundle.pathname.endsWith('.bundle'));
assert.equal(bundle.searchParams.get('platform'), platform);
const response = await fetch(bundle, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
if (!response.ok) {
  const error = await response.json().catch(() => ({}));
  throw new Error(
    `Dev ${platform} bundle: HTTP ${response.status} (${error.type ?? 'bundle error'})`,
  );
}
assert.ok(!response.headers.get('content-type')?.includes('json'), 'Expected a bundle, not JSON');
const bytes = (await response.arrayBuffer()).byteLength;
assert.ok(bytes > 1024, 'Dev bundle is unexpectedly empty');
console.log(`PASS: live ${platform} Dev manifest and bundle (HTTP 200, ${bytes} bytes)`);
