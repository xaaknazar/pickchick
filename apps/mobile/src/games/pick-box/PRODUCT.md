# Pick Box

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Pick Box is a portrait game in the existing React Native / Expo app for iOS and
Android. Web export is a development and visual review surface.

## Scope and authority

This record covers only Pick Box. It supplements
[`apps/mobile/PRODUCT.md`](../../../PRODUCT.md); it does not change other games,
ordering, payment or the shared design system. The durable surface contract is
[`docs/design/pick-box.md`](../../../../../docs/design/pick-box.md).

## Users and purpose

Restaurant guests can play a short, repeatable one-thumb stacking game alongside
the existing games. Success is a taller stable tower and a better local count.
The confirmed name is Pick Box, requested by the owner on 12 November 2026.

## Capabilities and constraints

- Tap to release the hanging box. Rigid-body collisions, rotation and balance
  determine whether it settles, misses or collapses the tower.
- Three lives; a missed release costs one life. A tower collapse can end the round.
  Stable placements increase the count; the camera rises and Almaty mountain
  scenery changes as the player advances.
- Pause/resume, replay and exit are available. Backgrounding pauses play. Reduced
  Motion removes decorative movement while preserving essential game physics.
- Only the best count is stored locally on the device, using the isolated key
  `pickchick.pick-box.best.v1`. An interrupted round is not restored.
- This game requires no account and performs no server writes or cross-device
  synchronization. It grants no money, Chiki, loyalty points or restaurant rewards.
  Existing account-backed progress rules for other games do not apply to this
  local record.
- Russian, Kazakh and English copy are implemented; Kazakh review remains open.

## Brand commitments

Preserve the owner-supplied PickChick packaging artwork and 23 x 23 x 10 cm box
dimensions. Gameplay uses the original PDF front artwork at a 23:10 face ratio.
The owner explicitly corrected the visual direction to 2D. The final selected cover
shows Alex standing beside the tower and stays unchanged. On 12 November the owner
requested more recognizable boxes and a painted city-to-space journey. Gameplay
therefore uses the original front/lid print with subtle dimensional projection,
without changing the physical dimensions. Alex flies on a rocket in space.
The footer instruction block is removed; the accessible tap field reaches the screen
bottom. Quiet translucent exit/pause controls keep 48-unit touch targets.
Almaty mountain stages are an artistic setting, not exact geographic views.
Shared PickChick identity and design authorities remain in force.

## Evidence and open acceptance

The [operations report](../../../../../docs/operations/pick-box-1112.md) records
completed checks and asset provenance. Browser checks and platform exports do
not establish physical-device acceptance. An iOS simulator build/runtime has
been checked; acceptance on physical iPhone and Android, native accessibility and
device performance remain open. This addition is not a store release or final
owner acceptance. No backend, financial integration or restaurant readiness is
claimed by this game record.
