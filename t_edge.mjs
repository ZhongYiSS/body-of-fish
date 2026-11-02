// 单独测 msedge-tts（ESM）：能不能连上、能不能出音频、多久。
process.noAsar = true
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

const voice = process.argv[2] || 'zh-CN-XiaoxiaoNeural'
const tts = new MsEdgeTTS()
const t0 = Date.now()
let bytes = 0
let chunks = 0
try {
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  console.log('metadata ok', Date.now() - t0, 'ms')
  const { audioStream } = tts.toStream('本鱼测试一下 Edge 朗读。')
  audioStream.on('data', (c) => {
    bytes += c.length
    chunks += 1
  })
  audioStream.on('error', (e) => console.log('stream error', e && e.message))
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log('timeout after', Date.now() - t0, 'ms, bytes', bytes, 'chunks', chunks)
      resolve()
    }, 25000)
    const done = (why) => {
      clearTimeout(timer)
      console.log(why, Date.now() - t0, 'ms, bytes', bytes, 'chunks', chunks)
      resolve()
    }
    audioStream.on('end', () => done('end'))
    audioStream.on('close', () => done('close'))
  })
} catch (e) {
  console.log('ERR', e && (e.stack || e.message || e))
} finally {
  try {
    tts.close()
  } catch {}
}
