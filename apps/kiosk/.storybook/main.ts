import type { StorybookConfig } from '@storybook/react-native-web-vite';
const config: StorybookConfig = {
  stories: ['../src/components/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-native-web-vite', options: {} },
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.define = {
      ...config.define,
      'process.env.EXPO_PUBLIC_KIOSK_COMMERCIAL': '"false"',
      'process.env.EXPO_PUBLIC_KIOSK_API_URL': '"http://127.0.0.1:9"',
      'process.env.EXPO_PUBLIC_API_URL': '"http://127.0.0.1:9"',
    };
    return config;
  },
};
export default config;
