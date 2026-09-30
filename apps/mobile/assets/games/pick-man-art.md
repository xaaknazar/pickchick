# Материалы PICK MAN

Обложка `pick-man-cover.png` предоставлена владельцем 8 сентября 2026.
Спрайт `pick-man-chick.png` подготовлен по персонажу обложки встроенным
инструментом image_gen. Это производная иллюстрация, не побитовое вырезание.
Выходные варианты с нарисованной шахматной сеткой отклонены: настоящий alpha
генератор не вернул. Принятый спрайт имеет тёмный фон под цвет лабиринта.

По новой просьбе владельца белые подложки фотографий еды заменены четырьмя
самостоятельными прозрачными SVG: `food-burger.svg`, `food-fingers.svg`,
`food-cola.svg`, `food-sauce.svg`. Объём передают градиенты, светлые кромки
и затенение поверхностей; это стилизованные 2D-иконки, не 3D-модели.
Они нарисованы в исходном векторном формате проекта, без image_gen.
Визуальный ориентир - фото меню: `shot.jpg`, `i4.jpg`, `i2.jpg`, `i18.jpg`.
На поле иконка занимает 70% клетки, Чик - 108%. Фонов и рамок у еды нет.

## Промпты image_gen

### 1

Use case: background-extraction. Asset type: transparent mobile maze-game player sprite. Input image: supplied Pick Chick arcade cover, edit target. Extract ONLY the large spherical white voxel chicken head in sunglasses with red comb and open yellow beak, located lower center-left of the cover. Preserve this character's identity, voxel construction, colors, black sunglasses, red comb, open beak and three-quarter right-facing pose. Remove the maze, logos, text, food, yellow pellets, glow trails, scenery and all other objects. One single character centered, entire silhouette visible, tightly framed with 5% transparent margin, square 512x512 PNG with genuinely transparent alpha background. No ground, no cast shadow, no checkerboard painted into the image. Clean sharp silhouette readable as a small game sprite. Do not redesign the chicken or include the small chicken logo.

### 2

Edit target: attached extracted voxel chicken sprite. Critical correction only: the gray-white checkerboard in the input is painted into an opaque RGB file. REMOVE that checkerboard completely. Deliver an actual RGBA PNG with alpha=0 in every background pixel, including between the open beak. Do not draw checker squares or a white background. Preserve the chicken exactly, including white voxel feathers, red comb, yellow open beak, sunglasses and right-facing pose. One tightly framed square game sprite, ideally 512x512. If alpha output is impossible, use perfectly uniform solid dark navy #020D27 instead of any checkerboard. No ground or shadows.

### 3

Precise background edit. Keep the single voxel chicken head with black sunglasses, white feathers, red comb and open yellow beak from the supplied image. Replace EVERY gray and white checkerboard square surrounding the chicken with one perfectly uniform flat dark navy RGB(2,13,39), hex #020D27, the same color as the game board. SOLID NAVY BACKGROUND REQUIRED. Do not make transparency. Do not draw ANY checkerboard. No texture, no vignette, no shadow, no extra objects, no text. Center complete character, face right, square composition with 4% margin. This is a small mobile game sprite; preserve full silhouette.
