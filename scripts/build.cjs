const esbuild = require('esbuild')
const yaml = require('js-yaml')
const fs = require('node:fs/promises')

esbuild.build({
  entryPoints: ['src/index.tsx'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  packages: 'external',
  plugins: [{
    name: 'yaml',
    setup(build) {
      build.onLoad({ filter: /\.ya?ml$/ }, async ({ path }) => ({
        contents: JSON.stringify(yaml.load(await fs.readFile(path, 'utf8'))),
        loader: 'json',
      }))
    },
  }],
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
