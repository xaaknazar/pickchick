---
name: Pick Farm
description: Painterly open meadow with a forest dock and cream controls
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
- Forest dock, cream panels and warm orange selection.
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

Native platform: adaptive React Native for iOS and Android. The farm opens fullscreen in landscape and restores portrait when leaving. The meadow covers the viewport while an independent camera pans and scales the isometric field. The logical field stays 64x64 with the house at (32,28); placement guides appear around the target cell. The projection advances 48 pixels horizontally and 24 vertically per axis.

The camera zoom clamps from 0.6 to 2. HUD and dock remain fixed outside the world transform. Safe-area offsets apply to exit, metrics, contextual tools and bottom dock. The dock caps at 620 pixels and fills available width. Panels scroll within the available height; wider screens above 700 pixels use a wider shop layout. Minimum buttons are 48x48 logical pixels; dock tools are at least 72x58. Preserve native Pressable, accessibility labels and modal behavior.

## Elevation & Depth

Painted shading creates scene depth; UI shadows separate controls from grass. Pills use a 3 pixel vertical offset, 9 pixel blur and 0.13 opacity; the dock uses 5/12/0.24; panels use 8/20/0.2. Native Android elevations are 3 for pills and 8 for panels. These are structural overlays, not animation cues. No perpetual plant sway.

## Shapes

Soft rectangular controls use the rounded scale, with panels and dock at its largest step. The selected cell is an isometric diamond formed from a square rotated 45 degrees and compressed vertically to 0.5. Sprite source rectangles use absolute overflow clips inside nonshrinking frames and preserve the generated PNG alpha.

**The Alpha Rule.** Clip source rectangles without flattening alpha or retaining adjacent atlas artwork.

## Components

Buttons use cream for secondary actions and forest for primary actions. Pressed opacity is 0.75; disabled opacity is 0.48. The dock combines icon and label with orange active state. Metrics sit in translucent forest pills. Cream panels expose shop, storage, orders, plot details, removal confirmation and help; choices use a warmer parchment inset. Shop purchase actions lead the panel: the bed button uses forest primary styling, with the tree button beside it. The culture strip follows with a visible scroll cue and compact 52 pixel crop previews; storage uses 64 pixel previews. The shop has no introductory text block. There is no standalone text-input component in this surface.

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
