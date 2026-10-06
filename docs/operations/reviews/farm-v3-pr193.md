# PICK FARM v3 - review PR193

Reviewed 6 October 2026. PR: https://github.com/xaaknazar/pickchick/pull/193.
Exact reviewed head: `f5676984583e3fdc82539472d7606092aeb7f7f7`.
Shared release baseline: `7e58f90bd13c2c60c8ff95d529f1513c1a9ab3d1` (TestFlight15).
This is a review report, not a merge, deployment or acceptance of balance.

## Findings

1. **P2 - accepted queued actions disappear on leaving the farm.**
   `pipeline.ts:147-154` disposes the pipeline and cancels its memory queue;
   `useFarm.ts:146` calls this on unmount, and the screen back action permits exit.
   Two accepted plant commands, with the first response delayed, display two planted
   beds. Leaving the screen sends only the first command; the second resolves as
   local CANCELLED and is not persisted. Confirmed server progress is not overwritten,
   but an action already shown as completed to the player disappears on return.
   Drain before navigation or keep an account-scoped durable action queue. Add a test
   for leaving/re-entering with several accepted actions and a delayed first response.

2. **P2 - watering stays disabled after the server upgrades from protocol2 to3.**
   `pipeline.ts:213-216` disables batching/watering after legacy INVALID_REQUEST.
   Refresh at line176 replaces the confirmed snapshot without restoring capabilities.
   `useFarm.ts` then exposes v3 features, while submit(water) is still rejected locally
   at line113. Reset capabilities when a confirmed server protocol transition enables
   them; retain explicit error fallback. Test 2 -> rejected water -> 3 -> successful water.

3. **P2 - changing Reduce Motion during entry can leave reward windows faded.**
   `RanchPanels.tsx:375-385` and `effects.tsx:468-480` stop an in-flight native spring
   in effect cleanup. When reduced becomes true, the new effect returns without moving
   the animated value to its final1. Set the final value explicitly in reduced mode.
   Static finding; physical iPhone reproduction was not performed.

## Release ordering

The statement that deployment order is arbitrary is not safe for service continuity.
`services/api/src/farm-controller.ts:55-63` rejects protocol2 with503 before persistence.
Current TestFlight12,14,15 use protocol2; deploying this API first blocks their farm.
First release the compatible new client and verify its availability to the intended
TestFlight group, then switch the API and accept that older clients require updating.
The external Testing group is still limited by Apple's pending review of build12.
If uninterrupted old-client support is required, an explicit compatibility strategy is
needed; merely accepting protocol2 against v3 state is not sufficient.

Before release, integrate current shared changes explicitly: PR193 does not contain
build15 and quiet order-status recovery. Do not replace shared development with the PR
branch or lose the latest mobile/payment fixes.

## Evidence and limits

- Foundation CI37446107115: success at exact f567698; roadmap CI also green.
- Locally rebuilt farm-game, then ran all41 engine tests: 41passed,0failed.
- Additional executable reproductions used the exact FarmPipeline and real compiled
  farm engine, with an isolated in-memory transport (no production calls):
  - upgrade: protocol3, watering=false, submit returns WATER_UNAVAILABLE, send count1;
  - exit: accepted2, predicted2, sent1, saved1, second result local CANCELLED.
- Economy/persistence review found no confirmed reward duplication or confirmed-save
  loss. Commands use server time, revision/row locking, strict validation and idempotency.
- All8 WAV files are valid PCM mono16-bit/22050Hz; referenced assets exist.
- iPhone FPS, audio playback, gestures and native screenshot acceptance remain unverified.
- Restaurant integration and push are plans only. Prices/feed balance still need owner
  acceptance. Optional restaurant rewards must not be silently enabled by this review.
- Old task farm-progression-api remains available in coordination. Its cleanup should
  be recorded after the replacement work is integrated; it was not closed by this review.

Recommendation: address the findings, rerun the targeted regressions, integrate with
current shared, then run the required release checks and publish client before API.
