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

## Painted replacement world - 2026-10-04

Owner rejected the mixed flat/low-poly prototype and explicitly requested a full
coherent generated redesign. Built-in image_gen produced the following assets.
Original PNG pixels and transparency are preserved; runtime clips the atlases.
No Lovely Farm artist files were copied.

- `meadow-painted-v2.png` (1536x1024): full-scene meadow, quiet central playable area.
- `props-painted-v2.png` (2172x724 RGBA): farmhouse, empty soil, planted sprouts.
- `plants-painted-v2.png` (1536x1024 RGBA): six species, three lifecycle rows.
  Final output is a background-removal edit of the generated plant sheet.
  Alpha checked: 728639 fully transparent pixels, maximum alpha254. The generated
  preview displays RGB under transparent pixels; compositing uses the actual alpha.

Generation prompt: meadow

> Create a production game environment background asset, landscape 3:2. Original premium hand-painted 2D isometric farming game, nostalgic sophisticated late-2000s browser farm illustration, lush but restrained natural colors, painterly detailed textures, NOT low poly, NOT toy blocks, NOT childish flat vector. View from above at 35 degree angle, orthographic, NO horizon or sky. This is a large OPEN GRASS MEADOW where user will freely place farm objects. Center 80% is empty gently textured olive/sage grass with subtle sunlit variations, absolutely no beds, crops or structures in central space. Only extreme outer corners have soft richly painted hedgerows, tiny wildflowers, rounded mossy rocks; a faint earthen path along far upper edge. Sunlight upper left, soft atmospheric depth but readable at phone scale. Color center muted grass #91ad60 with warm pale yellow lighting, edges deep forest green. No text, people, animals, buildings, fences, interface, logo, grid, watermarks. Beautiful cohesive professional game art, fully fills frame, unobstructed playable meadow.

Generation prompt: props

> Production 2D isometric farming game sprite sheet on TRUE transparent background, original sophisticated hand-painted illustration nostalgic browser farm style, natural textures, warm upper-left sunlight and soft contact shadows. Exactly THREE isolated assets side by side in one wide 3:1 canvas, equal thirds, separated with ample transparent margin, no overlap, no text. Left third: charming complete small farmhouse cream plaster walls, warm terracotta tiled roof, navy blue door, wood window shutters, porch, small flower box, orthographic35degree view, facing lower right, beautiful detailed architectural illustration not low-poly not blocky not toy. Middle third: single empty fertile cultivated soil bed, rhombus horizontal width2 height1, detailed dark brown soil and five parallel neat furrows following isometric axes, shallow raised earthy edges not wooden planter, no grass base. Right third: same single rhombus soil bed with nine tiny fresh green two-leaf seedlings in three straight rows. House fully contained left third, both bed objects centered other thirds, everything clear full size, no scenery, no people, no animals, no UI, no watermark. Consistent palette sage green, walnut soil, ivory, terracotta. Artwork must integrate into a professionally painted grass meadow.

Generation prompt: plants

> Production sprite atlas for original premium hand-painted 2D isometric farming game. Wide landscape 3:2 canvas, TRUE TRANSPARENT background. Exactly SIX columns and THREE rows in strict equal grid; all18 isolated plant sprites aligned in their cells, NO overlap. Each cell ample transparent padding. Columns left to right: carrot plant, tomato bush, strawberry plant, sunflower cluster, pink tulip cluster, compact apple tree. Row1: YOUNG GROWING plants, distinguish each species clearly, no ripe produce (apple sapling green). Row2: MATURE harvest-ready same species: carrot leafy tops with small orange shoulders at ground, tomato bush abundant red tomatoes, strawberry green leaves red berries, tall golden sunflowers, flowering pink tulips, leafy apple tree with red apples. Row3: WILTED/lost harvest: carrot dry ochre fronds, drooping brown tomato with spoiled tomatoes, shriveled strawberries with dry leaves, bent dry sunflower seedheads, wilted brown tulips, living apple tree with brown shriveled apples (tree survives). All18 share same high-quality nostalgic painterly illustrative style, detailed organic foliage, fine highlights, warm sunlight upperleft, orthographic camera at35degrees. No ground planes, no soil, no pots, no labels, no frames, no UI, no watermark. Plants grounded at bottom of each cell. Mature annual crops painted as small planted clusters, not harvested vegetables. Professional coherent farming game art, NOT glossy3D not lowpoly not flatvector.

Final edit prompt: plants transparency

> Remove ONLY the colored backdrop and all diffuse colored halos from this plant sprite atlas. Output genuine RGBA transparency in every pixel between plants and around leaves. Keep exactly all18 plants with their existing colors, layout, relative positions and complete shapes. Six columns bythree rows. No background plate, NO green/brown wash, NO shadows or gradients in transparent empty space, not a checkerboard illustration. This is for runtime sprite clipping: each plant must be an isolated clean cutout. Preserve painterly details and do not add/change subjects.

Previous generated cover remains on the game entry card. Previous Kenney and crop
atlases remain in repository as historical assets but no longer render the field.

## Soil texture v3 - 5 October 2026

`soil-texture-v3.png` generated with the built-in image_gen tool for PickChick.
Original output: exec-3cf6f2e2-547b-4f71-8422-d29767e0b0f7.png.
Copied without pixel edits. No external game artwork used.

Prompt: square seamless soil texture for an existing painterly mobile farming game.
Refined hand-painted TOP-DOWN orthographic texture of freshly cultivated warm
chestnut brown garden soil, softly rounded fine earth clumps and 5 shallow parallel
planting furrows running vertically. Soil fills every pixel to the edges, no outside
background, no diamond, perspective, raised island, grass, plants, seeds, stones or
objects. Warm soft daylight from upper left, moderate tonal variation, quiet readable
organic detail at tiny game scale. Flat slightly moist natural umber with gentle ochre
highlights, no black trenches, vignette or text. Square 1024x1024. The square is
projected to an exact 2:1 isometric diamond in native code.

## Watering can - 2026-10-06

`watering-can.png` is original procedural artwork drawn for PICK FARM by
`src/games/pick-farm/build-watering-can.py` (Pillow vector shapes, cylindrical shading,
light noise). No third-party image was used. Rebuild with the script if it changes.

## Grass cell tile - 2026-10-06

By the owner's request the painted meadow was replaced by one generated grass cell repeated
on every cell. `grass-tile.png` (192x192, one cell, seamless) and `grass-block.png` (the
same tile 8x8) are original procedural art from `src/games/pick-farm/build-grass-tile.py`
(seeded NumPy noise and Pillow strokes, deterministic). `meadow-painted-v2.png` is no longer
used and was removed from the app bundle; it remains in Git history.
