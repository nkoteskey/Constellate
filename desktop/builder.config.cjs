// electron-builder settings for the Constellate desktop app. Build steps (CI does these per OS):
//   npm run build                        # at the repo root: Constellate's code into dist/
//   node desktop/scripts/stage.mjs       # desktop shell + dist + production deps into desktop/stage
//   node desktop/scripts/fetch-x0x.mjs   # the pinned, checksum-verified x0xd for this OS
//   cd desktop && npx electron-builder --config builder.config.cjs
// Signing: macOS is ad-hoc signed and Windows is unsigned until the owner adds certificates
// (docs/DESKTOP.md). Set CSC_LINK / APPLE_* / WIN_CSC_LINK secrets to sign and notarize.
const signed = Boolean(process.env.CSC_LINK);

module.exports = {
  appId: 'io.github.nkoteskey.constellate',
  productName: 'Constellate',
  copyright: 'Constellate contributors',
  directories: { app: 'stage', output: 'release', buildResources: 'build' },
  asar: false, // Constellate's own programs run from these files with the app's runtime
  extraResources: [{ from: 'resources/x0x', to: 'x0x' }],
  artifactName: 'Constellate-${version}-${os}-${arch}.${ext}',
  publish: null, // releases are drafted by CI and published by the owner, never by the build
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    icon: 'build/icon.png',
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    notarize: signed && Boolean(process.env.APPLE_ID || process.env.APPLE_API_KEY),
  },
  dmg: { title: 'Constellate ${version}' },
  win: { target: ['nsis'], icon: 'build/icon.png' },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, artifactName: 'Constellate-Setup-${version}-${arch}.${ext}' },
  linux: { target: ['AppImage', 'deb'], syncDesktopName: true, category: 'Utility', icon: 'build/icon.png', maintainer: 'Constellate contributors', synopsis: 'Shared memory for AI agents and the people who work with them' },
};
