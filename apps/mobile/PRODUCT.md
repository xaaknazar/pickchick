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

## Magic Sort - 5 October 2026

The owner requested a portrait liquid-sorting game with 24 four-unit bottles, four wooden shelf rows and a tall yellow-only collector, following the supplied screenshot and recording. Magic Sort is the corrected name. Use original generated glass, cork, shelf and cover art with dynamic native liquid layers. This first playable slice has account-scoped local saves, undo, hints, restart confirmation and verified-solvable seeded levels. It does not award money, Chiki or restaurant benefits. Cross-device progress and native acceptance remain separate stages. See docs/design/magic-sort.md.

Follow-up: new Magic Sort levels use four colors in total (yellow, ivory, orange and wine), with legacy six-color saves preserved. Pouring should visibly drain the source and fill the receiver continuously, including the tall yellow collector, while committed progress changes only after the transfer finishes.
