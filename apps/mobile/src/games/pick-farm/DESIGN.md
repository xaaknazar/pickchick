---
name: Pick Farm
description: Painterly 32x32 meadow with direct gestures and cream controls
colors:
  primary: '#283E35'
  accent: '#F4AE57'
  paper: '#F8F0DD'
  field: '#748742'
  ink: '#18332C'
  muted: '#506253'
  border: '#CABB9E'
  growth: '#317247'
typography:
  display:
    fontFamily: 'Jost_700Bold'
    fontSize: '23px'
    fontWeight: 700
  heading:
    fontFamily: 'Jost_600SemiBold'
    fontSize: '20px'
    fontWeight: 600
  body:
    fontFamily: 'Manrope_400Regular'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'Manrope_700Bold'
    fontSize: '11px'
    fontWeight: 700
rounded:
  compact: '8px'
  metric: '12px'
  control: '14px'
  pill: '16px'
  panel: '20px'
spacing:
  tight: '4px'
  small: '8px'
  control: '14px'
  panel: '16px'
  roomy: '24px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '#FFFFFF'
    rounded: '{rounded.control}'
    padding: '0px 14px'
    height: '48px'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '0px 14px'
    height: '48px'
  dock:
    backgroundColor: '#283E35F5'
    textColor: '{colors.paper}'
    rounded: '{rounded.panel}'
    width: '620px'
  dock-active:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    height: '58px'
  panel:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: '16px'
  choice:
    backgroundColor: '#EEE4CC'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '14px'
    width: '148px'
---

# Design System: Pick Farm

## Overview

**Creative North Star: "A painted meadow"**

The meadow is the primary visual surface. Painted grass, a coherent farmhouse and soil, and six crops in growing, ready and withered stages form one 2D outdoor world. Forest controls and cream panels keep actions readable without covering the scene with dashboard cards.

This is a code-led redesign following the owner’s rejection of the flat green field and mismatched house. It records the implementation in styles.ts, visuals.tsx and PickFarmScreen.tsx; it is not an approved visual comp or final visual acceptance. The scope is this game only.

**Key Characteristics:**

- Painterly imagery with actual transparent sprite edges.
- Compact forest HUD, cream panels and warm orange cell selection.
- Fullscreen landscape with pan, pinch zoom and safe-area controls.

**The One Meadow Rule.** House, soil and crops share the painted world; do not mix unrelated asset styles.

## Colors

### Primary

Forest primary anchors the dock, primary actions and ready markers. Warm orange accent marks the active tool.

### Neutral

Cream paper supports floating controls and panels. Deep green ink and muted foliage carry text; parchment borders separate content. Field olive is the fallback beneath painted imagery. Growth green is reserved for crop context.

**The Selection Rule.** Warm orange identifies the active tool; keep its label readable in ink.

## Typography

Jost carries display and panel headings; Manrope carries body text, metrics and compact tool labels. Use the loaded native font names from the frontmatter. Body copy is 14 logical pixels with a 21 pixel line height; tool labels are 11 pixels. Metrics use Manrope bold at 15 pixels, captions Manrope semibold at 11 pixels. Do not add a separate game font.

## Layout

Native platform: adaptive React Native for iOS and Android. The farm opens fullscreen in landscape and restores portrait when leaving. The plantable field is a fixed 32x32 square (legacy coordinates 16..47 on each axis); the house is fixed at (14,14), outside that boundary. Historical 64x64 save coordinates remain valid. Older plots outside the new boundary remain intact and can be managed through help, without deleting their progress.

The initial camera fits the whole field and house. Zoom clamps from 1 to 8 relative to that fit; zooming out beyond the overview and panning at overview are disabled. Pinch zooms; one finger pans after zooming in. HUD remains outside the world transform. No bottom tool dock or directional placement arrows: tap an empty bed to choose seeds, tap a ripe crop to harvest, hold 420 ms and drag to move. Releasing outside the field or onto another plot cancels the move. Plot details use a compact contextual card with planting/removal actions; movement is direct hold-and-drag. Shop contains storage and orders; help contains the harvest destination and accessible zoom controls.

The projection advances 48 pixels horizontally and 24 vertically per axis. Soil, plants, cell outlines and touch conversion use the same coordinates. Only new purchases use a compact price/cancel control below the top HUD. Movement has no confirmation footer. Panels scroll within safe areas; minimum buttons remain 48x48 logical pixels.

## Elevation & Depth

Painted shading creates scene depth; UI shadows separate controls from grass. Pills use a 3 pixel vertical offset, 9 pixel blur and 0.13 opacity; the dock uses 5/12/0.24; panels use 8/20/0.2. Native Android elevations are 3 for pills and 8 for panels. These are structural overlays, not animation cues. No perpetual plant sway.

## Shapes

Soft rectangular controls use the rounded scale, with panels and dock at its largest step. The selected cell uses four lines joining the exact projected diamond corners, matching soil and hit testing. Sprite source rectangles use absolute overflow clips inside nonshrinking frames and preserve the generated PNG alpha.

**The Alpha Rule.** Clip source rectangles without flattening alpha or retaining adjacent atlas artwork.

## Components

Buttons use cream for secondary actions and forest for primary actions. Pressed opacity is 0.75; disabled opacity is 0.48. The bottom dock is removed; actions are contextual. Metrics sit in translucent forest pills. Cream panels expose shop, storage, orders, plot details, removal confirmation and help; choices use a warmer parchment inset. Shop purchase actions lead the panel: the bed button uses forest primary styling, with the tree button beside it. The culture strip follows with a visible scroll cue and compact 52 pixel crop previews; storage uses 64 pixel previews. The shop has no introductory text block. There is no standalone text-input component in this surface.

The imagery sources are meadow-painted-v2.png, props-painted-v2.png and plants-painted-v2.png. The props atlas provides house and soil; the plants atlas contains six columns and three phase rows, giving 18 crop sprites. Use clipped source coordinates from visuals.tsx rather than substituting emoji or screenshots. Decorative images remain outside the accessibility tree; actionable plots keep their own labels.

## Do's and Don'ts

### Do:

- Do preserve server-owned state, growth windows and existing game actions.
- Do keep the exit and contextual controls reachable above native safe areas.
- Do show the correct crop artwork for growing, ready and withered phases.

### Don't:

- Don't substitute flat green scenery or the rejected house for the painted meadow.
- Don't add perpetual sway, prearranged plots or decorations as part of this slice.
- Don't treat the web export as evidence that native landscape behavior passed.

## Economy interaction

Harvest defaults to an explicit sale destination: the primary action harvests and sells atomically, with a coin receipt. The alternative “На склад для заказов” retains produce and shows a quantity receipt. The destination selector lives in help and plot details, clear of the planting area. Direct harvest uses that same selected destination; every client harvest sends it explicitly. Neither mode silently sells stored order ingredients.

Seed choices distinguish seed cost, growth duration, full harvest sale revenue and net profit after seed cost. Plot acquisition is excluded from per-cycle seed profit and explained in help. Apple cards show the current upfront tree price, recurring harvest revenue without new seeds and payback harvest count. Current land purchase prices come from the shared economy helper and remain visible before placement; removal does not reset acquisition pricing. Plot details communicate the harvest window before maturity, then show its remaining time. Preserve the painted world and compact landscape layout.

## Planting feedback and verification - 5 October 2026

GroundCrop owns both the soil and plant anchor. The first 10% of growth shows seeds, 10-35% shows sprouts, then the crop-specific growing sprite. Ready and withered artwork remains crop-specific; apple trees use their tree lifecycle. A short seed-fall plays only after a new acknowledged planting, not on restoring a saved farm. Reduced motion and background state stop animation.

Verified with 18 engine/economy tests, 11 geometry/client tests, mobile TypeScript/ESLint and web export. An isolated 844x390 preview confirmed the overview, zoomed phases, planting (4 coins deducted) and tap harvest (39 coins and 10 XP awarded). Native pinch/long-press acceptance is pending. These changes require the next API deployment and native build; TestFlight 0.2.0 (10) remains unchanged.

## Precise interaction zones

Inspect and hold resolve the frontmost opaque sprite, including foliage above a neighbouring ground cell. Hit masks are generated from the existing atlas alpha at 128×128; transparent corners pass through. Placement resolves the ground diamond only. Dragging preserves the original grab offset. The measured game container, camera and zoom share one inverse coordinate conversion, including a native sheet offset. Out-of-bounds placement invalidates the selected destination instead of retaining an earlier valid cell.

## Contextual actions - 5 October 2026

No persistent bottom instruction strip or move-confirmation block. A ripe plot harvests directly; rapid taps on distinct plots are serialized and duplicates deduplicated. Empty/growing plots open a small card beside the object. Removing seeds/planting preserves the bed, with explicit destructive confirmation. Ground taps do not open a purchase prompt. Seed selection mode has only a small top cancel control. Farm API must support removeCrop before the next native release.
