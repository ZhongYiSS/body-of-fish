// 单独测 msedge-tts：能不能连上、能不能出音频。
process.noAsar = true
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')

async function main() {
  const voice = process.argv[2] || 'zh-CN-XiaoxiaoNeural'
  const tts = new MsEdgeTTS()
  const t0 = Date.now()
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    console.log('metadata ok', Date.now() - t0, 'ms')
    const { audioStream } = tts.toStream('本鱼测试一下 Edge 朗读。')
    let bytes = 0
    let chunks = 0
    audioStream.on('data', (c) => {
      bytes += c.length
      chunks += 1
    })
    audioStream.on('error', (e) => console.log('stream error', e.message))
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.log('timeout after', Date.now() - t0, 'ms, bytes', bytes, 'chunks', chunks)
        resolve()
      }, 25000)
      audioStream.on('end', () => {
        clearTimeout(timer)
        console.log('end', Date.now() - t0, 'ms, bytes', bytes, 'chunks', chunks)
        resolve()
      })
      audioStream.on('close', () => {
        clearTimeout(timer)
        console.log('close', Date.now() - t0, 'ms, bytes', bytes, 'chunks', chunks)
        resolve()
      })
    })
  } catch (e) {
    console.log('ERR', e && (e.stack || e.message || e))
  } finally {
    try {
      tts.close()
    } catch {}
  }
}

main()
