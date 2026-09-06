// The native storefront uses Expo Video in Brand.tsx. Metro selects the DOM
// adapter only for web, so its browser lifecycle does not affect iOS/Android.
export function WebHeroVideo(_props: { gradient?: string }) {
  void _props;
  return null;
}
