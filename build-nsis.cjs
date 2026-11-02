process.noAsar = true
const { build, Platform, Arch } = require('electron-builder')
build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' })
  .then(() => console.log('OK'))
  .catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1) })
