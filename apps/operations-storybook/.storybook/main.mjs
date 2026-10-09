export default {
  stories: [
    '../../backoffice/src/components/*.stories.js',
    '../../kitchen/src/components/*.stories.js',
  ],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/html-vite', options: {} },
  core: { disableTelemetry: true },
  staticDirs: [
    { from: '../../kitchen/dist/components', to: '/components' },
    { from: '../../backoffice/dist', to: '/backoffice-assets' },
    { from: '../../kitchen/dist', to: '/kitchen-assets' },
  ],
};
