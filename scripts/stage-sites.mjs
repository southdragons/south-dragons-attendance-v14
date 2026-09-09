import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
// Sites accepts a Worker entrypoint and a separate public asset directory.
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })
cpSync('.output/server', 'dist/server', { recursive: true })
cpSync('.output/public', 'dist/client', { recursive: true })
writeFileSync('dist/server/index.js', "export { default } from './index.mjs'\n")
