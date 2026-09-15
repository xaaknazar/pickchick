import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/pos-desktop/renderer/**',
      'apps/pos-desktop/release/**',
      'apps/pos-desktop/build/**',
      'apps/kitchen-desktop/renderer/**',
      'apps/kitchen-desktop/release/**',
      'apps/kitchen-desktop/build/**',
      'apps/kitchen-desktop/gateway.mjs',
      'apps/kitchen-desktop/.local/**',
      '**/.expo/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
      'apps/kiosk/ios/**',
      'apps/kiosk/android/**',
      '.local/**',
      'PickChick-technical-plan-v1/**',
      'docs/research/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'apps/mobile/**/*.ts',
      'apps/mobile/**/*.tsx',
      'apps/kiosk/**/*.ts',
      'apps/kiosk/**/*.tsx',
    ],
    languageOptions: { globals: { require: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['design/prototype/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        requestAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
];
