import type { ConfigContext, ExpoConfig } from 'expo/config';

export default function mobileConfig({ config }: ConfigContext): ExpoConfig {
  if (!config.name || !config.slug) {
    throw new Error('PickChick app.json must define name and slug');
  }
  const variant = process.env.PICKCHICK_APP_VARIANT ?? 'release';
  if (variant !== 'release' && variant !== 'development') {
    throw new Error('PICKCHICK_APP_VARIANT must be release or development');
  }
  const development = variant === 'development';

  return {
    ...config,
    name: development ? 'PickChick Dev' : config.name,
    slug: development ? 'pickchick-dev' : config.slug,
    scheme: development ? 'pickchick-dev' : config.scheme,
    ios: {
      ...config.ios,
      bundleIdentifier: development ? 'kz.pickchick.app.dev' : config.ios?.bundleIdentifier,
      // Native launch artwork must replace the previously installed Dev build.
      buildNumber: development ? '6' : config.ios?.buildNumber,
    },
    android: {
      ...config.android,
      package: development ? 'kz.pickchick.app.dev' : config.android?.package,
    },
    plugins: [
      ...(config.plugins ?? []),
      // SDK 57 also applies this plugin implicitly when the dependency exists.
      // Configure both variants explicitly so Release never gains exp+pickchick.
      // The native launcher is Debug-only; this does not configure EAS or OTA.
      [
        'expo-dev-client',
        {
          addGeneratedScheme: false,
          ...(development ? { launchMode: 'most-recent', toolsButton: false } : {}),
        },
      ],
    ],
  };
}
