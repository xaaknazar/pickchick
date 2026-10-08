# Storefront media map and catalog version signal

The mobile app and the iPad kiosk read the back-office publication through the storefront API.
This page describes the read-only additions for unified-menu photos and republish detection.

## Stripped catalog

`GET /v1/customer-checkout/catalog` and `GET /v1/kiosk-checkout/catalog` return the head
publication without the unified-menu product fields `image` (uploaded photo reference) and
`kitchen_route` (`stripStorefrontPayload`). Installed builds parse the payload with a strict
schema and would reject the whole menu otherwise. `image_asset_key` is unchanged and stays the
bundled fallback. The stored publication is never modified.

## Media map

- `GET /v1/customer-checkout/catalog/media?version=N`: same audience and flag as the mobile
  catalog (`CATALOG_MOBILE_STOREFRONT_ENABLED`); no customer session is required.
- `GET /v1/kiosk-checkout/catalog/media?version=N`: the same kiosk device and guest session
  headers as `GET /v1/kiosk-checkout/catalog`.

`N` must be the head catalog version. An older or newer version answers `409 CONFLICT`; the client
reloads the catalog first. A malformed or missing version answers `400`; no publication answers
`503 NOT_READY`. The body follows `CatalogMediaMapSchema`:

```json
{
  "version": 3,
  "products": {
    "burger": {
      "sha256": "<card sha>",
      "card": "/v1/media/catalog/<card sha>.card.webp",
      "hero": "/v1/media/catalog/<hero sha>.hero.webp",
      "thumb": "/v1/media/catalog/<thumb sha>.thumb.webp",
      "tile_color": "#FFFFFF",
      "cutout": true
    }
  }
}
```

Only products whose uploaded photo belongs to the branch organisation, still has all three stored
renditions, and whose card hash matches the publication are listed. Every other product keeps its
bundled photo. With `CATALOG_MEDIA_UPLOAD_ENABLED=false` (the default, and the kill switch) the map
is always empty, matching the 404 of the public media route. Before cloud migration 047 the map is
empty as well. Responses are `no-store`.

## Availability signal

Both availability routes set two response headers; the JSON bodies keep their exact old shape.

- `X-Catalog-Version`: the head catalog version (absent on the mobile route before the first
  publication or while mobile checkout is disabled).
- `X-Availability-Signature`: SHA-256 of the availability body plus the head catalog version.

The signature now covers the catalog version, so a republish that changes only prices or photos
wakes a waiting long-poll. Every installed client sees one extra wake-up after the release.

`GET /v1/kiosk-checkout/availability?after=<signature>` is now a long-poll like the mobile route:
without `after` it answers at once as before; with `after` it re-reads every second for up to 25 s
while the signature is unchanged. A pending back-office stop (cloud stop command) changes the
signature at once because it is part of `branchAvailability`.

## Release notes

- No migration and no new flag: the media map reuses `CATALOG_MEDIA_UPLOAD_ENABLED` and the
  asset tables of migration 047; everything else is a read-only change of the API image.
- The public gateway allowlists for `/v1/customer-checkout/*` and `/v1/kiosk-checkout/*` are
  maintained by the release scripts. The release must add `/v1/customer-checkout/catalog/media`
  and `/v1/kiosk-checkout/catalog/media` (GET, small body) before new clients rely on them; until
  then clients fall back to bundled photos.

## iPad kiosk client (build 8)

The kiosk reads both additions; installed build 7 ignores them and keeps working.

- After each catalog load the kiosk reads `GET /v1/kiosk-checkout/catalog/media?version=N` once per
  version and attaches the entry to each product (`image_id` stays `image_asset_key`). Any failure
  (404 before the gateway allowlist, 409, offline, a malformed map) keeps the bundled photos and is
  retried at most once a minute.
- Photo order: the published remote rendition (`card` for tiles, `hero` for the product page and
  set lines), then the bundled v3 photo of the image key, then the mockup shot, then the logo.
  `tile_color` and `cutout` come from the map, then from the bundled key, then white / no cutout.
  Every published photo is prefetched to the expo-image disk cache after a load; the immutable
  URL (it contains the rendition hash) is the cache key.
- A background long-poll runs on every screen, including the start/attract screen:
  `GET /v1/kiosk-checkout/availability?after=<X-Availability-Signature>` with a 32 s client
  timeout. New stops are applied at once without blocking the UI. When `X-Catalog-Version` is
  newer than the loaded publication, the idle start screen reloads the catalog at once; mid-session
  the loaded publication is kept and the existing quote `CONFLICT`/`PRICE_CHANGED` path decides.
  Errors back off 3, 6, 12, 24, then 30 s. Without the signature header (an older API) the kiosk
  reads availability every 15 s instead.
- After a guest finishes, the start screen allocates the next guest session in the normal refresh
  path (the same as a kiosk restart), so the long-poll keeps running between guests.
