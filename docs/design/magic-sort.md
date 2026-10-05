---
name: Magic Sort
description: Portrait glass-and-liquid sorting puzzle in the PickChick arcade.
colors:
  background: '#515B5C'
  surface: '#3D484A'
  ink: '#FCF4E3'
  accent: '#EDBB47'
  yellow: '#E6B91B'
  ivory: '#EEEFE9'
  taupe: '#AC9C87'
  orange: '#D88B50'
  rose: '#A46C79'
  wine: '#591F29'
typography:
  title:
    fontFamily: Jost_700Bold
    fontSize: 22px
  action:
    fontFamily: Manrope_700Bold
    fontSize: 11px
rounded:
  action: 14px
spacing:
  dock-gap: 8px
components:
  dock-action:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.action}'
    height: 48px
---

## Overview

Magic Sort follows the supplied portrait reference: 24 small glass bottles on four shelf rows, surrounding one tall central yellow collector. The realized React Native screen uses original generated glass, oak shelf/cork sprites and a separate arcade cover. Prompts and generation date are recorded in `apps/mobile/assets/games/magic-sort/provenance.json`; these assets are not copied from the reference.

Independent Impeccable documentation rationale: the muted teal backdrop gives the four liquids clear separation; glass highlights and warm shelves establish a tactile world without adding competing decoration. Gold marks the collector goal; selection uses a small bottle lift without a colored backdrop. The compact header and persistent action dock preserve board space and make the next interaction explicit. This rationale documents the implemented source, not an approved visual comparison or native acceptance.

## Colors

New version2 levels use four colors: yellow, ivory, orange and wine. They contain exactly88 units: yellow16 and24 each of the other three colors. Existing version1 saved games retain their six-color palette and exact generator; taupe/rose tokens remain only for that compatibility. Liquid is rendered from state behind the transparent glass artwork; selected bottles receive a gold highlight. A completed bottle is corked, giving completion a shape cue in addition to color.

## Typography

The header uses Jost700 at22px; action labels use Manrope700 at11px. Supporting text uses Manrope600 at12px. Help panels use Jost600 headings and Manrope400 body text. These are the existing mobile font families.

## Layout

The board has four rows of six small bottle positions, divided around the collector. Board width is capped at570px and follows the available viewport; the collector occupies10.5% of that width. Safe-area insets protect the header and dock. Small bottles hold four units; the collector holds16. Scrambled levels distribute eight spare small-bottle slots across partially filled bottles, so the number of entirely empty bottles varies.

## Elevation & Depth

Transparent glass reflections, the liquid meniscus and oak shelves provide depth. The pour timeline drains the source and fills the receiver continuously while a matching liquid stream joins their mouths. The glass returns to its shelf before the transaction commits. Reduced-motion handling and background interruption must preserve the committed board state; native motion quality remains to be verified.

## Shapes

Slim glass bottles and the taller central vial carry the reference composition. Full monochrome non-yellow small bottles automatically seal and become immutable. Yellow small bottles remain open because all yellow belongs in the collector. Action controls have14px radii and48px minimum height.

## Components

Select a source and then a destination. A legal pour transfers the largest contiguous top-color run that fits. A small destination must be empty or have the same top color; neither source nor destination may be sealed. The central collector accepts only yellow and never pours out. Overflow, invalid indices, self-pours and incompatible colors are rejected without mutation.

Victory requires16 yellow units in the collector and every nonempty small bottle full, monochrome and sealed. Undo reconstructs the previous board, including unsealing; reset replays the same version and seed. A new level or the confirmed “Новая раскладка” action starts version2 with four colors. Existing progress is never silently reset. No-move detection and hints are local engine functions. A hint follows the solution witness only while the move history matches its prefix; otherwise it is explicitly a valid suggestion, with no guarantee of solving the level.

Generation starts from a solvable crossed-color template and applies deterministic reverse moves. Each scramble is accepted only when its legal maximal forward inverse restores the exact previous board. Inverses are prepended to the witness, and the complete witness must replay to victory. The original version1 test sample of seeds0-99 contains three-color bottles and buried yellow;54 contain four-color bottles, with53-68 witness moves. This is historical version1 evidence, not a claim that all bottles have four distinct layers. The bounded scramble can saturate before its target; this is not an optimal-solution or difficulty ranking.

Persistence is local and account-scoped. The storage adapter serializes load/save/clear operations, captures saves before queued writes and continues after storage failures. Saves are bounded to100,000 string characters and1024 moves. Validation regenerates the version-specific seed, checks the original witness and replays all history, rejecting corruption, illegal moves and changed contents. An eight-entry cache keyed by version and seed returns independent copies. There are no money, loyalty points or other financial rewards.

## Do's and Don'ts

Keep actual liquid layers, capacity and cork state visible. Label off-witness hints as suggestions. Preserve account isolation and safe interruption of pending pours. Do not infer native readiness from browser or engine checks.

Verification: `node --test tests/mobile/magic-sort.test.mjs` passed7 tests, including100 seed replays, conservation, capacity, collector rules, sealing/undo, invalid saves and queued account persistence. Scoped ESLint, Prettier, strict TypeScript with `noUncheckedIndexedAccess`, and `git diff --check` passed. A local Mac benchmark of100 serializations at100-move history took7.92ms total; this is not a phone-performance measurement. Expo iOS/Hermes and web exports passed. A browser journey made all60 solution moves through the bottle controls, verified illegal pours, undo, restart cancellation/confirmation and saved progress at320/390/430 widths without page errors. Root additionally checked guest login continuation and a normal animated pour through the actual UI. A physical-phone build, layout/gestures/performance and TestFlight distribution have not yet been checked for Magic Sort.

## Follow-up evidence

The first version (d95f263, PR177) passed full GitHub CI37229709651 and the verify workflow; its roadmap package was published with API/payment/kitchen services unchanged. Four-color version2 generation passed8 engine/storage tests including100 new witnesses, plus exact comparison of100 legacy version1 seeds with the published generator. The fixed legacy save fixture includes8 valid moves and retains resume/undo/reset behavior.

Continuous-flow browser verification (2026-10-05): full 63-move v2 solution,
ordinary and collector transfer at 320/390, measured source drain and target
rise before commit, transfer fractions agree, mouth endpoints within 4 px.
Pause after flow restores the last committed board; resume commits once.
Rapid taps and reduced motion pass; no JavaScript errors. Local artifacts:
`.local/magic-sort/browser/flow-{ordinary,collector}-{320,390}.png`.
Native rendering remains unverified; this is web evidence, not iPhone acceptance.

Final bounded correction: reserve extra flight clearance on screens <=340 px.
The 320px collector flow was rechecked after export: flying source stays below
the move counter, board and controls remain inside the viewport; transfer and
pause/restore checks still pass. The full 63-move suite was not repeated for this
layout-only correction.

## Bottle selection correction (2026-10-05)

A tap on an incompatible or full unsealed bottle now switches the source instead
of trapping the previous selection. Compatible targets still pour; tapping the
source again deselects it. Empty/sealed bottles and the collector cannot become
sources. The golden selection backdrop is removed; only the bottle image lifts,
keeping its touch area fixed.

10 engine/storage/interaction tests, mobile TypeScript/ESLint and web export pass.
Browser 390x844 verified source switching, no move counted on selection, ordinary
and collector pours after switching. Screenshot: `/tmp/magic-sort-selection-fixed.png`.
This correction is not in TestFlight build 10; native acceptance and a new build
remain separate release steps.
