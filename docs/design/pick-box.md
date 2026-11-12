# Pick Box - mobile game surface

## Product and scope

Owner, 12 November 2026: add a tower-stacking game alongside existing PickChick
games. The confirmed name is Pick Box. The later visual correction explicitly
requires a playful 2D arcade, not a realistic 3D presentation. Local records only;
no purchases, financial rewards, account requirement or backend writes.

The scope-local product record is
[`PRODUCT.md`](../../apps/mobile/src/games/pick-box/PRODUCT.md). This document
records only the Pick Box surface. The existing
[design system](design-system.md), `packages/design-tokens` and
[design workflow](ai-design-workflow.md) remain the shared authorities.

## Direction contract

- User: a restaurant guest playing a short, repeatable one-thumb game on a phone.
- World: vivid 2D Almaty, flat illustrated mountain silhouettes, cream clouds,
  cobalt and orange packaging, dark outlines. The supplied PDF is authoritative
  for the printed box artwork; the photo specifies 23 x 23 x 10 cm.
- First viewport: full-frame arcade illustration, Pick Box title, one start action,
  a short three-lives/collapse rule. The poster also appears in the Games tab.
- Cover revision, owner 12 November: Alex is above the tower, holding a rope with
  both hands and lowering a tied Friends Box. The illustrated Almaty background
  remains. `cover-alex-2d.png` is 1536 x 1024, matching the other Alex game covers,
  and uses the unchanged shared poster size. Gameplay sprites are unchanged.
- Gameplay composition: count centered above an open playfield, record left,
  three hearts right, named peak below. A rope enters from above; the player's
  box hangs over the tower. One bottom action remains available to accessibility
  and keyboard users; the whole playfield accepts a tap.
- Signature interaction: release, physical impact, a small spark burst and score
  response, followed by a camera rise. Exact alignment earns a PERFECT streak,
  without altering collisions or offering money. No simulated reward economy.
- Motion: fixed-step rigid bodies; UI-thread sprite transforms; camera easing and
  panorama pan. Pause/backgrounding stop play. Reduced Motion removes decorative
  shake, particles, score scaling and camera easing, preserving essential physics.

### FORM and direction provenance

Mode: Experience. Form: portrait illustrated stacking arcade, extending the
existing Games collection through `GamePosterCard`. The owner supplied the
packaging PDF/photo, specified the stacking behavior and Almaty setting, then
explicitly corrected the direction to illustrated 2D. The blue/orange identity
and Jost/Manrope typography are inherited PickChick commitments.

No concept roll, ranked form list or random FORM seed was used. Seed and list
position are not applicable to this constrained extension; none is reconstructed
after implementation. The generated cover is illustration, not an approved
full-screen interface comp. Its generation prompts and provenance are recorded in
[`provenance.json`](../../apps/mobile/assets/games/pick-box/provenance.json);
the exact packaging source and crop coordinates are in
[`packaging-source.json`](../../apps/mobile/assets/games/pick-box/packaging-source.json).

### QUALITY BAR - constrained reference card

- Reference: the owner's packaging PDF/photo for print fidelity and 23 x 23 x 10 cm
  dimensions; `cover-alex-2d.png` and `mountains-2d.png` for illustrated style.
- Incumbent component: [`GamePosterCard.tsx`](../../apps/mobile/src/games/GamePosterCard.tsx),
  already used by [`MagicSortCard.tsx`](../../apps/mobile/src/games/magic-sort/MagicSortCard.tsx),
  governs entry-card composition. The game retains its own open playfield.
- Required result: recognizable original box print, readable count and lives,
  unobstructed tower/rope, visible bottom action, consistent 2D mountains and
  safe-area controls. The generated cover does not define collision dimensions.
- Ceiling: no external QUALITY BAR reference or independent reference board was
  selected. These constrained sources establish fidelity and continuity, not
  an externally calibrated quality rating or owner acceptance of the final UI.

## Tokens and components

Uses incumbent Jost display / Manrope body families. Main ink #04143A, box blue
#0047BB, printed orange from the original artwork, sky #16C2DC, cream #FFF4D5.
The 2D stage is a deliberate game surface within the existing mobile shell;
global navigation, branding and design tokens are unchanged. Icon buttons are
48 x 48, primary actions at least 54 high, safe-area insets protect controls.
World width 360 logical units; body width 126, height 126 * 10 / 23. Display caps
at 540 while larger screens retain side margins. Score and HUD are event-driven.

The exact PDF front face is used as a flat sprite, with a narrow blue lid edge.
The generated cover is illustrative, not the collision geometry. Artwork source
hash and crop coordinates are in the asset directory. The extracted lid remains
available as source art but is not perspectively rendered in the 2D game.

Observed local type: Jost 54/66 for the start title, 64/74 for the live count,
30/39 for overlay titles; Manrope 15/21 for the subtitle, 13/20 for rules and
18/25 for primary actions. These are game-specific sizes, not new global tokens.
The local primary action uses #FF842F; it does not replace brand orange #FF6900.

## Route and interaction

- `/games/pick-box`, registered with the existing full-screen arcade options.
- Games tab card after Magic Sort; no existing game is removed or altered.
- A single tap drops one box. Further taps wait until landing or a miss resolves.
- Three lives. Each missed release costs one; a lost foundation or a majority of
  the counted tower falling ends the attempt. One falling box is never charged twice.
- Count increments only after 300 ms of supported, sufficiently calm contact.
- Mountain stages: Алматы (0), Пик Фурманова (8), Кумбель (20), Талгар (36).
  This is an artistic route, not a claim of geographic elevation or exact views.
- A local best persists; an interrupted round is intentionally not restored.
- Pause/resume, replay, exit, Android Back and browser visibility handling.
- Russian, Kazakh and English copy. Kazakh remains subject to native-speaker review.

## Evidence boundary

See `docs/operations/pick-box-1112.md` for the exact completed checks. Browser
phone layouts and platform bundle exports are distinct from native device tests.
Do not describe a source change as an App Store / Play release or owner acceptance.

Current local captures are in `.local/pick-box/browser/` and
`.local/pick-box/native/`. Native evidence covers an iOS simulator build/runtime;
physical iPhone/Android acceptance remains open. Local files are inspection
evidence, not shared durable acceptance records; the operations report owns the
published check results.

Not canonized: the shared poster component retains its existing 9-unit category
label and 11-unit description. This extension does not change that component or
promote its compact text to a new typography rule. Native readability acceptance
remains open. No global DESIGN.md, product record or token authority is replaced.
