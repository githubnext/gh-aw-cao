import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', '.lazy-page-chunks-*/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[property.name="length"][object.type="CallExpression"][object.callee.type="MemberExpression"][object.callee.property.name="rows"]',
        message: 'Use source availability metadata for existence checks or a declarative count query instead of materializing rows.'
      }],
      'no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }]
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
];
