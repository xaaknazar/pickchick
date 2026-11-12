# Pick Box - mobile game surface

## Product and scope

Owner, 12 November 2026: add a tower-stacking game alongside existing PickChick
games. The confirmed name is Pick Box. The later visual correction explicitly
requires a playful 2D arcade, not a realistic 3D presentation. Local records only;
no purchases, financial rewards, account requirement or backend writes.

## Direction contract

- User: a restaurant guest playing a short, repeatable one-thumb game on a phone.
- World: vivid 2D Almaty, flat illustrated mountain silhouettes, cream clouds,
  cobalt and orange packaging, dark outlines. The supplied PDF is authoritative
  for the printed box artwork; the photo specifies 23 x 23 x 10 cm.
- First viewport: full-frame arcade illustration, Pick Box title, one start action,
  a short three-lives/collapse rule. The poster also appears in the Games tab.
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
