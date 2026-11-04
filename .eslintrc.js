module.exports = {
  root: true,
  extends: 'airbnb-base',
  env: {
    browser: true,
  },
  parser: '@babel/eslint-parser',
  parserOptions: {
    allowImportExportEverywhere: true,
    sourceType: 'module',
    requireConfigFile: false,
  },
  rules: {
    'import/extensions': ['error', { js: 'always' }], // require js file extensions in imports
    'linebreak-style': ['error', 'unix'], // enforce unix linebreaks
    'no-param-reassign': [2, { props: false }], // allow modifying properties of param
  },
  overrides: [{
    files: ['tools/**', 'test/**'],
    env: { node: true, es2022: true },
    rules: {
      'import/no-unresolved': ['error', { ignore: ['^node:', '^playwright$'] }],
      'import/extensions': ['error', { js: 'always', mjs: 'always' }],
      'no-script-url': 'off', // tests assert the CM360 javascript: click-through
      'object-curly-newline': 'off', // compact fixtures
      'no-bitwise': 'off', // crc32, deflate headers, GIF LZW
      'no-await-in-loop': 'off', // one browser, one ad at a time
      'no-restricted-syntax': ['error', 'ForInStatement', 'LabeledStatement', 'WithStatement'],
      'max-len': ['error', { code: 160, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  }],
};
