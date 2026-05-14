module.exports = {
  root: true,
  overrides: [
    {
      files: ['src/{server,core,adapters,frontend}/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            {
              group: ['../remote/**', './remote/**', '../../remote/**', '../../../remote/**', 'src/remote/**'],
              message: 'Runtime imports from src/remote are local-only unsafe. Use import type, or dynamic import from src/server/index.ts inside the KOOKR_RELAY_URL branch.',
              allowTypeImports: true,
            },
          ],
        }],
      },
    },
  ],
};
