# Kiosk HD artwork - 14 October 2026

Owner-requested image polish. These are **AI-retouched cut-outs**, not new camera originals.
The original supplied photographs remain unchanged. Transparent alpha separates the food
from the card illustration; there is no multiply blend through opaque product pixels.

`signature-60.png` uses the supplied small clear sauce cup. The displayed 60 ml comes from
the selected existing catalog size; no prices, nutrition or catalog entries were changed.
`heinz-cheese.png` and `heinz-bbq.png` are portion illustrations based on that cup with the
respective sauce contents. They do not claim to photograph Heinz retail packaging.
`sauce-hot.png` matches the same elevated three-quarter camera angle and cup framing,
as requested by the owner. Its spicy red-orange contents are preserved.
The shared photo renderer aligns the visible cup bounds and scale, ignoring transparent
padding. Sauce options reserve equal photo/text space; image proportions are preserved.

Sources, pixel dimensions and SHA-256 values are in `provenance.json`. Outputs have at least
1200 pixels on their long side. Existing owner-supplied bottled-drink photographs remain in
`../../drinks`. No artificial HD claim is made for arbitrary future
remote catalog assets. Card background geometry lives in `../bg/*.svg` for resolution-independent rendering.

## Pick Combo follow-up

Built-in imagegen retouched the previous cut-out on 14 October. Output: `pick-combo.png`,
1254×1254 RGBA. The source and previous hash remain in provenance; this is detail retouching,
not a claim of a 2048 px output. The card uses more of its existing photo area and selects
the hero rendition for remote media.

Prompt used:

> Edit the supplied PickChick Pick Combo product photograph for a large iPad kiosk card. This is a fidelity-preserving resolution/detail enhancement, not a new meal or rearrangement. Preserve EXACTLY the photographed food quantities, positions, bottle with gold cap and Coca-Cola branding, sesame toast, crispy chicken, potatoes, two sauce cups, coleslaw, black tray, PickChick printed paper, camera angle and silhouette. Improve fine realistic photographic clarity and natural microtexture, avoid oversharpening, oily plastic appearance or invented ingredients. Preserve readable original packaging text. Deliver the highest available resolution, ideally 2048x2048 or larger, clean true transparent alpha background, the whole product fully visible with a narrow 3% clear margin. No drop shadow, no extra props, no drawn background, no additional text. The source image is the exact edit target and composition reference.
