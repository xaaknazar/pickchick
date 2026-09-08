/* global require, module, __dirname */
/* eslint @typescript-eslint/no-require-imports: "off" */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo watches workspace packages by default; this shared directory is not a package.
config.watchFolders = [
  ...new Set([...config.watchFolders, path.resolve(__dirname, '../../config')]),
];

module.exports = config;
