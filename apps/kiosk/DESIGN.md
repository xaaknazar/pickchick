# PickChick iPad UI

White ordering surfaces, blue #0047BB navigation/selection, orange #FF6900 primary purchase actions with dark text. Dark #15213A text and #5A6579 secondary text on pale #F6F7F9 canvas. Main reading text is at least 18 points; captions at least 16. Touch controls at least 48 points. Card corners 16 points, main actions 16; restrained borders, no decorative patterned wallpaper behind the order.

Two product columns in portrait, three in wide web layout. Category rail stays visible and independently scrolls. Grid scroll position is retained when returning from a product. Menu hierarchy: compact header, three real ordering stages, category title, product images and price, persistent cart. Product detail uses a light photo/option layout and fixed quantity/add action. Cart and review share the same typography, image and amount components. Authoritative order status owns the success wording.

## Component ownership

Screens compose components and coordinate existing domain actions. All visual components live directly in src/components. UI.tsx is only a re-export barrel. Wrapper exposes layout only; it never clones children or forwards a style bag. Native View, Text, Image and Pressable appearance lives inside the owning component. Appearance changes use finite semantic variants, tones and sizes. No style, className, textStyle, CSS-like appearance props or arbitrary prop spreading into components. The architecture test enforces these boundaries and a matching Storybook entry for each exported visual component.

## Motion

Button press: 140 ms, small 0.98 scale. Confirmed cart quantity increase: short 1.12 pulse then damped spring, with a text confirmation. Confirmed order: one short checkmark settling animation. No entrance choreography or layout shift of fixed actions. No delayed click execution. Reduced Motion/background disables decorative movement; the information remains visible. Modal uses fade only when motion is enabled. Video lifecycle remains in Hero.

## References and verification

See docs/design/ipad-mobbin.md for canonical links, limitations and evidence. See docs/design/ipad-ui-refactoring.md for the per-file migration record. Storybook uses the real components, native-web renderer, same fonts, synthetic catalog and synthetic QR. It never needs production credentials or payment endpoints.
