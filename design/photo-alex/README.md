# Alex invites guests to the photo booth

Owner request, 15 October 2026: move the photo entry from the attract screen to
the ordering menu, with an animated Alex in a corner. Preserve the guest's cart.

`alex-camera.png` is a transparent asset generated with imagegen from the existing
`apps/mobile/assets/order-status/chef-ready.png` character reference. White rooster,
red comb, black sunglasses, orange sleeves and royal blue apron retained. A compact
instant camera replaces the food tray; no chef hat, added lettering or background.
Original generated output is preserved locally. This is a new pose, not a new mascot.

The native PhotoEntry animates the cutout with a short lean and camera pose, then
a seven-second pause. No video, audio, flashing light or added animation dependency.
Reduced Motion, backgrounding, a disabled entry and the open camera stop the loop.
The entry has reserved space below the scrollable categories, above checkout.

The owner chose “Хрустящий момент на память. Приятного аппетита!” and requested
three translations, then clarified that only the language selected in the menu
must appear on paper. `print-caption-{kk,ru,en}.svg` contains one language per
asset, below the photo; the logo is now above the photo. The capture request
passes the current menu locale; the service selects one allowlisted asset and
the client refuses a preview reporting a different language. Old clients without
a locale keep Russian as the compatibility default.
The Kazakh text is adapted as “Қытырлақ сәт - тәтті естелік. Ас болсын!”.
English: “A crispy moment to remember. Enjoy your meal!”.

Regenerate the vector asset with `python3 design/photo-alex/build-caption.py`
(authoring dependency: fontTools). It uses the existing Golos Text Medium font
from `@expo-google-fonts/golos-text`, licensed under SIL OFL 1.1 (see
`font-OFL.txt`). All requested Kazakh characters exist in its cmap. The service
needs neither fontTools nor system fonts; captions become the same binary raster
as the preview. Text never enters the printer's character-code-page mode.
