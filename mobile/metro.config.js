// Lets Metro bundle the shared packages/core (linked via file:../packages/core).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const core = path.resolve(__dirname, '../packages/core');
config.watchFolders = [...(config.watchFolders || []), core];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), path.resolve(core, 'node_modules')];
module.exports = config;
