import type { StorybookConfig } from '@storybook/react-native-web-vite';
const config: StorybookConfig = {
  stories: ['../src/components/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-native-web-vite', options: {} },
  core: { disableTelemetry: true },
};
export default config;
