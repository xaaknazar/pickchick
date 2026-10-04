# PickChick mobile

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

React Native / Expo application for iOS and Android; web export is a development and visual review surface.

## Users and purpose

Restaurant guests browse food, order for takeaway or dine-in, follow fulfillment and revisit for games. The owner explicitly wants games enjoyable independently of food purchases.

## Confirmed constraints

The existing ordering and payment flows remain separate from game state. Authenticated server identity owns persistent player progress. Client clocks, balances and claimed rewards are not authoritative. Game currency is not restaurant money or a loyalty balance.

The owner approved an initial farm inspired by the gameplay of Lovely Farm: vegetables, fruit, flowers and trees, planting, harvesting, a store, inventory, orders and persistent progress. Animals are outside this first stage. The revised slice keeps all six crops on an open 64x64 field. Players buy and place individual beds or permanent apple trees (one cell each), with a fixed house as an anchor. Start with an empty field and 500 coins; beds cost150 and trees250. Growth takes hours; the harvest window equals growth time, then the crop is lost and must be cleared. Trees survive lost harvests. Remove perpetual sway and the prearranged island. Fences, decorations and house upgrades come later.

The farm opens fullscreen in landscape on phones, with pan and pinch zoom. Leaving it restores the normal portrait app. Safe areas and a visible exit remain available. Background growth follows server time.

## Brand commitments

Preserve PickChick branding, Jost/Manrope typography and established blue/orange controls. The farm uses a distinct painterly 2D meadow, coherent house/soil artwork and 18 crop stage sprites, with a forest/cream/orange interactive dock. This code-led replacement follows the owner's rejection of the flat green scene and mismatched house; there is no approved visual comp yet. Restaurant screens retain their established visual system. Use original or appropriately licensed art, not unverified archived Lovely Farm assets.

## Evidence and open decisions

Existing visual authority: docs/design/design-system.md, docs/design/ai-design-workflow.md, packages/design-tokens and the mobile reference source. Farm direction and scope approved in the conversation on 4 October 2026. Detailed crop economics are prototype configuration, not an approved restaurant reward programme. Public release, long-term progression, social features and real rewards need subsequent acceptance.
