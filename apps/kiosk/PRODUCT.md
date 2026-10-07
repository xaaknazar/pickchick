# PickChick iPad kiosk

Public restaurant tablet for guests ordering fast food without signing in. The guest chooses dine-in or takeaway, browses the actual restaurant menu, configures a meal, reviews the cart, and pays through the existing trusted payment flow. Russian and Kazakh UI. Primary orientation is portrait, 768-1024 points wide; web landscape is a resilience check, not a change to the native orientation lock.

Owner brief, 2026-10-07: combine multiple Mobbin references for a restaurant-specific iPad redesign; include restrained contemporary motion. Later instructions require strict component encapsulation, layout-only Wrapper, flat components directory and a Storybook entry for every visual component. Layero and Designeer are research sources. These instructions authorize the UI redesign, not a server or physical-device rollout.

Success means a guest can see the menu categories and cart action, read actual product descriptions, configure required options, and complete the existing order flow with clear feedback. Money, stock, ordering identity, trusted bank confirmation, recovery, QR validity, and enrollment semantics stay in their existing domain modules. Test payment remains explicitly labelled; no fabricated ratings, discounts, preparation estimates or bank success states.

Known constraints: native fonts currently bundled with the kiosk are Montserrat and Golos Text; reuse them, independently of the customer mobile app's Jost/Manrope system. Use the owner's product photos and offline assets. Two drinks without supplied photographs keep a neutral icon. No video pause control on the attract screen; reduced motion and background suspension remain enabled.
