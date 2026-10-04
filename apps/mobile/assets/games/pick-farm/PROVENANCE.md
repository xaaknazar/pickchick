# Pick Farm artwork

Original PNGs from Kenney, Isometric Miniature Farm (2019, CC0):
https://kenney.nl/assets/isometric-miniature-farm
Download https://kenney.nl/media/pages/assets/isometric-miniature-farm/abd0274182-1670690319/kenney_isometric-miniature-farm.zip
soil=dirtFarmland_N; sprouts=cornYoungDouble_N; hay=hayBalesStacked_N;
roof=roof_N; door=woodWallDoorClosed_N; wall=woodWallWindowGlass_W;
fence=fenceLow_N; fence-side=fenceLow_W.
Original PNGs from Kenney, Isometric Miniature Bases (CC0):
https://kenney.nl/assets/isometric-miniature-bases
Download https://kenney.nl/media/pages/assets/isometric-miniature-bases/eb165ab941-1686811744/kenney_isometric-miniature-bases.zip
grass=square_grass_flat_N; path=square_stone_flat_N.
Original license files are included. PNG pixel data is unchanged.

Botanical SVG icons from game-icons.net, CC BY 3.0:
https://creativecommons.org/licenses/by/3.0/
Carrot, tomato, strawberry, sunflower and fruit-tree by Delapouite:
https://game-icons.net/1x1/delapouite/carrot.html
https://game-icons.net/1x1/delapouite/tomato.html
https://game-icons.net/1x1/delapouite/strawberry.html
https://game-icons.net/1x1/delapouite/sunflower.html
https://game-icons.net/1x1/delapouite/fruit-tree.html
Flowers by Lorc (used for the tulip crop):
https://game-icons.net/1x1/lorc/flowers.html
SVGs downloaded from the site's transparent color export, unchanged.
The flower icon is a botanical symbol, not an exact tulip illustration.
Attribution is also available within the farm help panel.

## Original generated artwork - 2026-10-04

Built-in image_gen was used (not CLI/API fallback). Files are copied unchanged,
including crop atlas alpha, into this project:

- `cover-generated.png`: original farm cover with cottage, six crops and meadow.
- `crops-generated.png`: six plant sprites, rendered with clipped native views;
  the generated PNG itself is not cropped or recolored.

Prompt, cover: polished original hand-painted 3D isometric miniature farm,
terracotta cottage, carrot/tomato/strawberry/sunflower/tulip beds, small apple tree,
wooden fence, harvest crate; natural greens, warm orange and blue door, spring light,
quiet meadow at the bottom for UI; no people, animals, logo, text or watermark.

Prompt, plants: transparent production atlas with 3 columns and 2 rows, carrot
cluster, ripe tomato bush, strawberry plant, sunflower, pink tulips, compact apple
tree; consistent 3/4 view, warm upper-left light, detailed rounded hand-painted 3D
casual game style, individual isolated sprites, no soil/pots/text/grid/watermark.
Result is 1254x1254 RGBA. Runtime regions follow the actual illustration bounds.
The previous botanical SVG references remain licensed but are no longer rendered.

## Lost-harvest atlas - 2026-10-04

`crops-withered-generated.png`: built-in image_gen edit of the original crop atlas,
transparent 1254x1254 PNG copied unchanged. Runtime clips each measured sprite region.
Prompt: preserve the six-cell layout, scale, isometric angle and painted 3D style;
carrots with dry ochre fronds and shriveled roots; limp brown tomato bush with spoiled
fruit; dried strawberry leaves/berries; bowed sunflowers and fallen petals; dry drooping
tulips; living green apple tree with shriveled fruit and fallen apples. No text, floor,
UI or background. Distinct lost crop for each species; apple tree does not die.
