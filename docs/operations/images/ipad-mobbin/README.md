# iPad kiosk visual evidence

2026-10-07, task ipad-mobbin-design. These are actual screenshots of the final React Native Web export and static Storybook at tablet viewports. All API requests use the isolated synthetic fixture; no restaurant order or bank payment was sent. They do not prove installation or native-device acceptance.

- Menu: 768×1024, 820×1180, 1024×1366.
- Product, cart and welcome: 820×1180.
- Recommendations: 1024×1366.
- Order ticket: 768×1024.
- Kazakh menu: 834×1194.
- Storybook ProductCard: 820×1180.

verification.json records screenshots' SHA256, exact exported bundle hashes, all 92 rendered story IDs and the synthetic payment proof. 46 visual component entries are represented. Implementation, per-file refactor and research: docs/design/ipad-ui-refactoring.md and docs/design/ipad-mobbin.md.
