# Kiosk component library

Run from the repository root with the pinned Node/pnpm toolchain:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @pickchick/kiosk storybook
corepack pnpm --filter @pickchick/kiosk storybook:build
corepack pnpm --filter @pickchick/kiosk ui:check
```

Development: http://127.0.0.1:6006. Static build: `.local/ipad-design/storybook`; serve with `python3 -m http.server 6007 --bind 127.0.0.1 --directory .local/ipad-design/storybook`.

All stories live next to their real component in `src/components/*.stories.tsx`. Use Controls to explore semantic props and Accessibility to review the rendered state. Tablet viewport presets: 768×1024, 820×1180, 1024×1366 and 1180×820. Global KioskFonts loads the same bundled fonts as the app. The Default and state stories are synthetic; their callbacks are Storybook spies and cannot submit a restaurant order.

Appearance props (`style`, `className`, `textStyle`, raw colors/radii/fonts) are not part of component APIs. Add a meaningful variant inside the component and its story when appearance differs. Use Wrapper for layout only. Screens do not declare local visual components. The AST architecture check fails if those boundaries or story coverage regress.

Browser acceptance, after a local Expo web export on port 4195 and static Storybook on port 6007:

```sh
KIOSK_UI_URL=http://127.0.0.1:4195 KIOSK_UI_OUTPUT=.local/ipad-design/final python tests/kiosk/browser_mobbin.py
```

Requires Python Playwright with Chromium. The suite renders every story and runs Axe WCAG 2.1 A/AA rules using the locally installed Storybook dependency. `.github/workflows/kiosk-ui-library.yml` runs this automatically for kiosk changes. The existing `browser_ui.py` suite covers ordering/recovery separately. Full native iPad acceptance is still required before an installed release.
