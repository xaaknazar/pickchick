# PICK FARM - садовый атлас

Оригинальные растровые изображения сгенерированы встроенным imagegen для
уютной садовой фермы. Визуальный ориентир - существующий
`apps/mobile/assets/games/pick-farm/props-painted-v2.png`: тёплое дерево,
кремовый камень, терракота, мягкий дневной свет и рисованная фактура.
Это игровые украшения; предметы не дают настоящие товары или ресторанные награды.

## Файлы и API

- `apps/mobile/assets/games/pick-farm/garden-atlas-v1.png` - прозрачный атлас 4×4.
- `apps/mobile/src/games/pick-farm/GardenArt.tsx` - native Image с кадрированием целой ячейки.
- `GardenArt({ id, size=92 })` - локальный квадрат без собственного позиционирования мира.
  Мир задаёт координату; компонент не добавляет фон, цену, touch target или анимацию.
- `GardenArtId` и `GARDEN_ART_IDS` экспортированы; все имена совпадают с каталогом движка.
  `mint`/`sunshine` - небольшие акценты дома, не замена самого дома.

| Ряд | Колонка 1 | Колонка 2 | Колонка 3 | Колонка 4 |
| --- | --------- | --------- | --------- | --------- |
| 1   | path      | fence     | flowerpot | bench     |
| 2   | lantern   | birdhouse | fountain  | arch      |
| 3   | pond      | picnic    | statue    | gazebo    |
| 4   | kitchen   | florist   | mint      | sunshine  |

Атлас 1254×1254 RGBA, диапазон alpha 0–255. Некоторые края рисунков
близки к условным границам сетки, поэтому компонент использует измеренные
прямоугольники `GARDEN_ART_BOUNDS`, исключая соседние предметы.
Изображение масштабируется равномерно, помещается в `size×size`, центрируется
по горизонтали и опирается на нижний край. Файл не разрезается и не перерисовывается.

## Финальный промпт

Original transparent sprite atlas for PICK FARM. Square canvas, exact uniform
4 columns ×4 rows, 16 discrete cutout sprites, each centered within its own equal
square cell, transparent gutter at least 10% all sides. No sprite crosses its cell,
no labels, no grid lines, no background planes. Warm hand-painted semi-realistic
cozy farm artwork, weathered honey wood, cream stone, terracotta, natural greens,
small purple/white/orange blossoms. Same fixed isometric viewpoint from above
with 2:1 ground diamonds, gentle upper-left sunlight, soft local contact shadow,
realistic texture brushwork, no black outlines, no emoji or vector icons.

Exact row-major order: Row1: square stepping-stone path tile with four cream-grey
stones; short rustic wooden picket fence; terracotta pot with daisies; wooden garden
bench. Row2: lantern on rustic wooden post; birdhouse on a short timber pole;
compact cream-stone water fountain; wooden rose-climbing garden arch. Row3: small
oval garden pond ringed with stones and reeds; rustic picnic table with two benches;
little cream-stone ornamental chicken statue on low plinth; small open wooden garden
gazebo with terracotta roof. Row4: compact outdoor garden kitchen workstation,
wooden table with fruit crates, copper juice press and jars, no lettering; florist
bouquet workstation, wooden bench with flower buckets and small cloth canopy,
no lettering; decorative mint-painted cottage window shutters with white flowerbox,
isolated accent; decorative sunny yellow cottage window shutters with white
flowerbox, isolated accent. All sixteen entire objects visible. Objects consistent
in perspective and painterly family with a warm stone farmhouse with terracotta
roof and blue door. Give each generous transparent margin. No characters, no brands,
no text, no solid backdrop, no extra sprites. True transparent alpha background,
high quality square atlas.

## Проверка

Полный атлас просмотрен после генерации: все 16 предметов соответствуют порядку.
Alpha проверен чтением PNG: RGBA, диапазон 0–255. Компонент прошёл scoped TypeScript,
ESLint и Prettier. Полная mobile TypeScript-проверка отдельной свежей рабочей копии
ограничена отсутствующими dist внутренних workspace-пакетов; её повторяет
интеграция после сборки зависимостей. Нативная производительность и игровая
приёмка входят в общую интеграцию, не подтверждаются одним атласом.
# Original harvest audio

`apps/mobile/assets/games/pick-farm/garden-harvest.wav` is an original 0.32-second
mono PCM chime synthesized locally from sine tones with attack/decay envelopes.
No sampled recordings or third-party music. Sound is optional and off by default.
