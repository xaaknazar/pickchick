# iPad kiosk: Mobbin design synthesis

Owner-authorized redesign and UI architecture work, 2026-10-07. Task `ipad-mobbin-design`, branch `codex/ipad-mobbin-design`. Based on shared development plus kiosk checkpoint `54f84f3`, with shared `16adcea` explicitly integrated. The owner approved splitting UI from `kiosk-kaspi-qr` and later requested strict encapsulation and Storybook. Domain controllers, API clients, storage, contracts, database and server remain unchanged by this UI stage.

## Research through Mobbin MCP

All three available capabilities were inspected: screen search, multi-step flow search, website-section search. Screen and flow tools were used for the ordering product; website marketing sections were not relevant. Images were examined, not inferred solely from metadata. Multiple references were combined rather than copied as a single template.

The MCP exposes neither rating/popularity nor release-date sorting and returns screenshots, not downloadable motion timelines. Accordingly none of the references is claimed to be “most rated”, “most popular” or “latest”. Motion below is authored for the kiosk. Canonical links remain usable without the temporary image URLs.

The owner subsequently broadened the brief beyond food apps. A second MCP pass examined Faire Wholesale recommendations, Ulta Beauty product detail and Under Armour's browse/detail/recommendation flow, alongside foodpanda, Glovo and Blue Bottle. Their product hierarchy and recommendation patterns inform the entrance choreography; the timing itself is authored and tested locally. The browser's [Mobile Explore](https://mobbin.com/explore/mobile) filter was verified, including its public Popular Collections and What's trending sections. The full browser library requires sign-in; rating/latest sorting was not available in the authenticated MCP.

| Additional reference                                                                               | Applied observation                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Faire Wholesale recommendations](https://mobbin.com/screens/aadf39a0-6214-45f3-8d0c-0f3006c70293) | Product-first supplementary offers and persistent checkout.        |
| [Ulta Beauty details](https://mobbin.com/flows/83c738de-cabf-44ee-ac04-6c5c3c1d3fec)               | Related products grouped near the primary product action.          |
| [Under Armour product journey](https://mobbin.com/flows/407ecc97-f853-4976-9339-af07947f1109)      | Photography-led grid, explicit choice, and related-item discovery. |
| [foodpanda suggestions](https://mobbin.com/screens/dfa269f1-75ee-4283-aa22-73f9a1b33b37)           | Compact suggestions with immediate add actions.                    |
| [Glovo basket](https://mobbin.com/screens/370df234-85f2-4557-983c-12db2b0d29b3)                    | Clear separation of chosen items, suggestions and fixed total.     |
| [Blue Bottle suggestions](https://mobbin.com/screens/14d11c3d-83eb-44bd-901a-98cb128ecd3d)         | Restrained imagery and supplementary items before checkout.        |

| Reference                                                                                  | Observed pattern and application                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [DoorDash menu](https://mobbin.com/screens/0014b86b-bf3b-4d9e-b32e-7ef50a1a9322)           | Persistent category navigation and image grid; adapted to 2 portrait columns with touch-sized category rail. |
| [DoorDash ordering flow](https://mobbin.com/flows/dd5c1ed4-eed8-467a-b6b1-99c6a3d3c897)    | Browse, configure, basket, checkout continuity; fixed main action per stage.                                 |
| [Deliveroo ordering flow](https://mobbin.com/flows/0b899cf8-1a4d-4648-a61a-f01b9b024e64)   | Restaurant categories and food-first browsing. No delivery address flow in a restaurant kiosk.               |
| [Wonder ordering flow](https://mobbin.com/flows/98f64881-9a1e-466a-8031-1c85a2864b8f)      | Item choices and checkout sequencing.                                                                        |
| [Grill’d product](https://mobbin.com/screens/a1f0ea54-e267-4855-86a0-f90fdaf0d0f2)         | Large product photo, readable options, fixed quantity/add action.                                            |
| [Uber Eats modifiers](https://mobbin.com/screens/7446baf2-57b7-40c8-ac59-22c0a0f6e4a2)     | Light option groups and unambiguous required radio selections.                                               |
| [HelloFresh menu](https://mobbin.com/screens/8c1c5e91-3a0e-44b7-9212-391020f0fd62)         | Consistent image proportions and product information hierarchy.                                              |
| [HelloFresh basket](https://mobbin.com/screens/91c362a1-94b1-4992-b926-261a9acb924a)       | Clear line items and total; adapted to full-width portrait rows and fixed footer.                            |
| [Uber Eats basket](https://mobbin.com/screens/1c63a65a-26f2-4436-9bc5-cea68001de0e)        | Thumbnails, quantity and price hierarchy.                                                                    |
| [Sweetgreen basket](https://mobbin.com/screens/f1215db9-91de-46d4-93d3-a35cd5b1500b)       | Compact order summary and distinct checkout action.                                                          |
| [Subway adding to bag](https://mobbin.com/flows/e952ba78-bbb0-47bc-91ac-6ead9c2a7fb8)      | Immediate, explicit added feedback near basket navigation.                                                   |
| [CAVA adding to bag](https://mobbin.com/flows/a7829a70-48e1-4d57-a8c1-ad77bb13887f)        | Food imagery and readable selected side dishes.                                                              |
| [Cherrypick adding to shop](https://mobbin.com/flows/c55e5422-2e1d-4d81-9c5b-f13b7bc0c8fe) | State change with an added confirmation; no unverified ranking copied.                                       |

## Other requested sources

[Layero](https://icons.layero.app/) was inspected in the browser. Five original SVG files (arrows, check, hamburger, bowl) are bundled locally and mapped inside `Icon`; no network dependency for icon rendering. Remaining utility symbols use the existing Ionicons set. Asset provenance is recorded in `apps/kiosk/assets/icons/README.md`.

[Designeer](https://www.designeer.xyz/) was inspected through its browser WebMCP catalogue. The motion search returned Motion Primitives, Animate UI and other web-oriented libraries. Its reading catalogue links [Refactoring UI](https://refactoringui.com/). These are research pointers, not native runtime dependencies. The user's explicit encapsulation rules govern this implementation. `/ui-refactoring` was not an installed skill or callable command.

Motion follows the use of short interaction feedback described by [Apple’s motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion). Built-in React Native Animated handles a 140 ms press, 260 ms product entrance, 320 ms recommendation entrance with a bounded 45 ms stagger, confirmed-cart pulse and confirmed-order checkmark. Only opacity and transforms animate; layout and fixed actions do not move. Reduce Motion and background suspension finish motion immediately. There is no new animation package or animation of money values.

## Result and boundaries

The same blue/orange identity runs from mode choice to confirmation. Product photos are the customer's existing offline assets. Screens contain composition and state; components own appearance. The customer mobile app and its `mobile-v2.html.txt` visual source were not replaced. Native orientation remains portrait. No server, bank, production order, enrollment credential or physical iPad installation was changed.

Implementation and browser verification are distinct from native-device acceptance. This stage exports the iOS Hermes bundle and tests React Native Web at 768×1024, 820×1180, 1024×1366, plus 834×1194 Kazakh and 1180×820 resize fallback. Native visual acceptance and installation on the restaurant iPad remain a separate next step.

## Evidence

- `tests/kiosk/browser_ui.py`: 6 existing flows, including quote/line totals, modifiers, fixed actions, no extra orders, scroll restoration and uncertain-payment recovery.
- `tests/kiosk/browser_mobbin.py`: language/resize/dialog checks, confirmation feedback with Reduce Motion, and all Storybook stories rendered from the built library.
- `tests/kiosk/ui-architecture.test.mjs`: component API boundary, screen composition, Wrapper constraints, Storybook coverage.
- `corepack pnpm test:kiosk`: 72 tests passed before final publication.
- TypeScript, ESLint, production Expo iOS/web export, static Storybook build and Impeccable scan are recorded below.
- Screenshots in `docs/operations/images/ipad-mobbin/` are synthetic browser fixtures, not screenshots from the physical iPad or evidence of bank integration.

Global `docs/project-status.md`, roadmap and collaboration handoff are reserved by another active task. This scoped document records implemented/verified facts without overwriting that owner's files. Online roadmap publication is not performed from this UI task.

## Verified implementation checkpoint

- `pnpm check`: passed, including workspace build/typecheck/lint/format, 148 unit tests, contracts and design catalogue consistency.
- `pnpm test:kiosk`: 72/72 passed, including four AST architecture guards.
- `browser_ui.py`: 6/6 passed against the final web bundle; three portrait iPad sizes, basket totals, modifier choices, replay/recovery and unknown payment preservation.
- `browser_payment_success.py`: 1/1 passed; exactly one synthetic order and payment command, payment-method accessibility state, bounded actions and high-contrast order ticket.
- `browser_mobbin.py`: 3/3 passed; Kazakh/landscape fallback, live Reduce Motion during a held press, recommendation motion settling, and all 92 stories rendered without JavaScript errors.
- 46 visual components have Storybook entries. Native and web Hero implementations share one platform-resolved entry.
- Expo iOS Hermes and web exports and static Storybook build passed. Final TypeScript/ESLint checks were repeated after motion changes.
- Impeccable detection returned no findings. `pnpm audit:release` passed its high/critical gate; four moderate advisories remain reported by the audit, not suppressed by this task.

The browser preview initially served an older output directory during an additional motion regression. It was corrected to serve `apps/kiosk/dist`, and all three browser suites above were rerun against that exact final export. Screenshots and SHA256 records are in `docs/operations/images/ipad-mobbin/`.

The shared CI workflow is reserved by `tiptoppay-checkout`, so it was not edited. Existing CI runs the architecture guards via `test:kiosk` and the existing browser/payment suites. The new Storybook/render and motion suite is reproducible with `apps/kiosk/STORYBOOK.md`; wiring that additional suite into CI requires the workflow owner's next checkpoint.
