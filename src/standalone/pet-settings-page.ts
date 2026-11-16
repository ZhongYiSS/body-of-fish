/** 独立模式的设置页（**一页到底**：不用联网的和要联网的都在这里，不再分两页）。外部同源资源，CSP 不含 unsafe-inline。 */
export const petSettingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="stylesheet" href="/standalone-pet/pet.css">
<script src="/standalone-pet/pet.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">🐾</span><p class="local">独立桌宠 / 本机设置</p>
<h1>桌宠设置</h1><p class="intro">一页改完：外观、位置、手感、人格、对话模型、看图与声音。<br>带「联网」标注的才需要网络，其余都是本地生效。</p></header>
<form id="settings">
<div class="gtabs" role="tablist" aria-label="设置大项">
<button class="gtab is-on" type="button" role="tab" data-gtab="look" aria-selected="true">外观</button>
<button class="gtab" type="button" role="tab" data-gtab="model" aria-selected="false">模型</button>
<button class="gtab" type="button" role="tab" data-gtab="watch" aria-selected="false">陪伴</button>
<button class="gtab" type="button" role="tab" data-gtab="more" aria-selected="false">其他</button>
</div>
<div class="gpane is-on" data-gpane="look">
<fieldset><legend>这只宠物</legend>
<div class="pair"><label for="name">名字</label><input id="name" name="name" type="text" maxlength="24" required></div>
<div class="pair"><label for="size">大小（像素）</label><input id="size" name="size" type="number" min="80" max="1200" step="10" required></div>
<label class="check"><input id="desktopVisible" type="checkbox"> 在桌面上显示这只桌宠</label>
<label class="check"><input id="fixedEnabled" type="checkbox"> 固定不动（不掷骰随机走向，只播待机）</label>
<div class="pair"><label for="corner">贴边角落</label><select id="corner" name="corner">
<option value="top-right">右上</option><option value="top-left">左上</option><option value="bottom-right">右下</option><option value="bottom-left">左下</option></select></div>
<div class="pair"><label for="marginX">左右边距（像素）</label><input id="marginX" type="number" min="0" max="4000" step="1" required></div>
<div class="pair"><label for="marginY">上下边距（像素）</label><input id="marginY" type="number" min="0" max="4000" step="1" required></div>
<label class="check"><input id="confineToScreen" type="checkbox"> 锁定在当前屏幕（不让它跑到别的显示器）</label>
</fieldset>
<fieldset><legend>人格（它是谁）</legend>
<label for="persona">人设提示词</label>
<textarea id="persona" rows="6" maxlength="4000" placeholder="留空则使用自带的默认人设。"></textarea>
<p class="hint">这段话就是它的"性格和说话方式"：碎碎念、看一眼、对话共用这一份（写清它是什么身份、怎么称呼你、说话什么调子就够）。清空保存 = 恢复默认人设。</p>
</fieldset>
<fieldset><legend>气泡字体</legend>
<div class="pair"><label for="fontFamily">字体</label><select id="fontFamily" name="fontFamily">
<option value="system">系统默认</option><option value="yahei">微软雅黑</option><option value="youyuan">幼圆</option>
<option value="kaiti">楷体</option><option value="simsun">宋体</option><option value="candy">圆体（candy）</option><option value="comic">Comic Sans</option></select></div>
<div class="pair"><label for="fontSize">字号（像素）</label><input id="fontSize" type="number" min="4" max="200" step="1" required></div>
<label class="check"><input id="followPet" type="checkbox"> 字号跟着宠物大小走</label>
</fieldset>
<fieldset><legend>提示气泡（【在看】【在说】这一层）</legend>
<div class="pair"><label for="hintSize">字号（像素）</label><input id="hintSize" type="range" min="10" max="22" step="1"> <span id="hintSizeOut"></span></div>
<p class="hint">只影响「【在看】/【在说】/开关提示」这层小气泡；头顶对话气泡的字号在上面「气泡字体」里调。</p>
<div class="hint-drag" id="hintDrag"><div class="hint-body"></div><div class="hint-bub" id="hintBub">【在看】</div></div>
<p class="hint">按住这行小字拖，摆到你顺眼的位置，保存后桌面上就按这个位置摆（0,0 是默认位置）。</p>
</fieldset>
<fieldset><legend>手感（拖拽与下落）</legend>
<div class="pair"><label for="gravity">重力</label><input id="gravity" type="number" min="0" max="8000" step="50" required></div>
<div class="pair"><label for="restitution">弹性（0–1）</label><input id="restitution" type="number" min="0" max="1" step="0.01" required></div>
<div class="pair"><label for="groundFriction">地面摩擦</label><input id="groundFriction" type="number" min="0" max="50" step="0.1" required></div>
<div class="pair"><label for="throwPower">投掷力度</label><input id="throwPower" type="number" min="0.05" max="5" step="0.05" required></div>
<label class="check"><input id="ceilingBounce" type="checkbox"> 碰到屏幕顶部会弹</label>
</fieldset>
</div>
<div class="gpane" data-gpane="model">
<div class="profile-row" id="profile-row" hidden>
<span class="profile-label">模型方案</span>
<div class="ptabs" id="profile-tabs" role="tablist"></div>
<button id="profile-add" class="profile-mini" type="button">＋ 新建一套</button>
<button id="profile-rename" class="profile-mini" type="button">改名</button>
<button id="profile-remove" class="profile-mini" type="button">删除这套</button>
</div>
<p class="hint" id="profile-hint" hidden>一套方案 = 对话 + 看图 + 声音的整套设置。点页签就换（换之前会先把这一套的改动存回去）；新的一套从当前设置复制出来。</p>
<fieldset class="model-section"><legend>模型（联网）</legend>
<div class="mtabs" role="tablist">
<button class="mtab is-on" type="button" data-mtab="chat">对话模型</button>
<button class="mtab" type="button" data-mtab="vision">看图</button>
<button class="mtab" type="button" data-mtab="voice">声音</button>
</div>
<div class="mpane is-on" data-mpane="chat">
<div class="pair"><label for="protocol">接口协议</label><select id="protocol" name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></div>
<div class="pair"><label for="maxTokens">单次输出上限（tokens）</label><input id="maxTokens" type="number" min="128" max="4096" step="1" value="1024" required></div>
<label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false">
<label for="model">模型名称</label><input id="model" type="text" maxlength="200" placeholder="例如 deepseek-chat" spellcheck="false">
<label for="extraHeaders">自定义请求头（可选，每行一条 Key: Value）</label>
<textarea id="extraHeaders" rows="3" spellcheck="false" placeholder="x-opencode-session: body-of-fish"></textarea>
<p class="hint">有些网关（例如 opencode Go）必须带自己的请求头才给用。留空 = 不带。鉴权、Content-Type 这类由程序自己管，写了也会被忽略。</p>
<label for="apiKey">API 密钥 <span id="key-state" class="hint">尚未读取</span></label>
<input id="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥">
<label class="check"><input id="enabled" type="checkbox"> 启用 AI 对话</label>
<label class="check"><input id="clearApiKey" type="checkbox"> 清除已保存的密钥，并关闭 AI</label>
<div class="test-row"><button id="test-btn" type="button">测试连接</button><span id="test-result" class="test-result" role="status" aria-live="polite"></span></div>
<p class="hint">没接对话模型时，「陪伴」和「看一眼」会直接提示「未接入聊天模型」——它们必须让模型过一遍人格才说话，不念识图原文。</p>
</div>
<div class="mpane" data-mpane="vision">
<div class="pair"><label for="visionMode">后端</label><select id="visionMode">
<option value="off">关（陪伴、看一眼都不可用）</option><option value="local">本地</option><option value="remote">云端</option></select></div>
<div class="pair"><label for="visionEndpoint">本地地址</label><input id="visionEndpoint" type="text" maxlength="512" placeholder="http://127.0.0.1:1234/v1"></div>
<label for="visionModel">模型名</label><input id="visionModel" type="text" maxlength="200" placeholder="例如 qwen2-vl-7b-instruct / gpt-4o-mini">
<div class="pair"><label for="visionBaseUrl">云端接口地址（留空 = 沿用对话模型）</label><input id="visionBaseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1" spellcheck="false"></div>
<label for="visionApiKey">云端 API 密钥 <span id="vision-key-state" class="hint">尚未读取</span></label>
<input id="visionApiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥">
<label class="check"><input id="clearVisionApiKey" type="checkbox"> 清除识图自己的密钥（回落对话模型那把）</label>
<p class="hint">本地 = 本机开着的识图服务（LM Studio、ollama 之类）；云端 = 可以单独填地址与密钥，两栏留空就沿用上面「对话模型」那一份。</p>
</div>
<div class="mpane" data-mpane="voice">
<div class="pair"><label for="voiceMode">后端</label><select id="voiceMode">
<option value="off">关</option><option value="local">本地</option><option value="remote">云端</option></select></div>
<div class="pair"><label for="voiceProtocol">发声协议</label><select id="voiceProtocol">
<option value="openai">标准接口（/audio/speech）</option><option value="sovits">GPT-SoVITS（/tts）</option><option value="system">Windows 自带（离线免费）</option><option value="edge">Edge 在线（免费，要联网）</option></select></div>
<label for="voiceEndpoint">本地地址</label><input id="voiceEndpoint" type="text" maxlength="512" placeholder="http://127.0.0.1:9880">
<label for="voiceModel">模型名 / 音色</label><input id="voiceModel" type="text" maxlength="200" placeholder="留空用服务端默认">
<div class="pair"><label for="voiceBaseUrl">云端接口地址（留空 = 沿用对话模型）</label><input id="voiceBaseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1" spellcheck="false"></div>
<label for="voiceApiKey">云端 API 密钥 <span id="voice-key-state" class="hint">尚未读取</span></label>
<input id="voiceApiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥">
<label class="check"><input id="clearVoiceApiKey" type="checkbox"> 清除声音自己的密钥（回落对话模型那把）</label>
<div class="pair"><label for="voiceRefAudio">参考音（绝对路径）</label><input id="voiceRefAudio" type="text" maxlength="512" placeholder="D:\\\\AI\\\\GPT-SoVITS\\\\_ref.wav"></div>
<div class="pair"><label for="voicePromptText">参考音说的话</label><input id="voicePromptText" type="text" maxlength="500" placeholder="与参考音逐字一致"></div>
<div class="pair"><label for="voiceVolume">播放音量（0–100）</label><input id="voiceVolume" type="range" min="0" max="100" step="5"><span id="voiceVolumeOut" class="test-result"></span></div>
<div class="pair"><label for="voiceStaleSec">排队过期（秒）</label><input id="voiceStaleSec" type="number" min="1" max="600" step="1"><span class="test-result">没轮到的句子超过这么久就作废，内容并进下一句</span></div>
<div class="pair"><label for="voiceGapMs">句子间隔（毫秒）</label><input id="voiceGapMs" type="number" min="0" max="5000" step="100"><span class="test-result">两句之间停多久，0 = 不停</span></div>
<p class="hint">音量只影响「放出来多大声」，不改合成。100 = 原声；0 = 静音（气泡照常）。Windows 自带语音没有音量参数，所以不是 100 时会改用系统媒体播放器播。</p>
<p class="hint">GPT-SoVITS 靠「参考音 + 它说的那句话」定音色，两个都要填、且必须对得上；标准接口不用管这两栏。「Windows 自带」离线免费、是机器音；「Edge 在线」不用填地址和 key、要联网。云端时接口地址与密钥可以单独填，留空就沿用对话模型那一份。</p>
</div>
</fieldset>
</div>
<div class="gpane" data-gpane="more">
<fieldset><legend>全局快捷键</legend>
<div class="pair"><label for="earHotkey">按住说话</label><input id="earHotkey" type="text" maxlength="32" placeholder="留空 = Alt+T"></div>
<div class="pair"><label for="peekHotkey">看一眼屏幕</label><input id="peekHotkey" type="text" maxlength="32" placeholder="留空 = Alt+G"></div>
<div class="pair"><label for="sayHotkey">说一句</label><input id="sayHotkey" type="text" maxlength="32" placeholder="留空 = Alt+S"></div>
<p class="hint">写成 <code>Alt+T</code> 这种形状（修饰键加主键，可多个修饰键）。留空就用默认；改完保存，桌面壳会自己跟上，不用重启。被别的软件占用时会注册失败，换一个组合试试。</p>
</fieldset>
</div>
<div class="gpane" data-gpane="watch">
<fieldset><legend>陪伴（看屏幕说话：提示词与评分）</legend>
<p class="hint">她看一眼屏幕，然后按「即时陪伴」的口气说一句。留空 = 用自带的默认提示词。</p>
<label for="watchPrompt">陪伴用的提示词（留空 = 用默认）</label>
<textarea id="watchPrompt" rows="16" maxlength="16000" spellcheck="false" placeholder="留空则使用自带的默认提示词。"></textarea>
<p class="hint">可用占位符：<code>{{persona}}</code> 人设、<code>{{picture}}</code> 图说明、<code>{{window}}</code> 窗口 / 网页 / 视频名、<code>{{bili}}</code> B站剧情梗概、<code>{{brief}}</code> 现况、<code>{{events}}</code> 最近事件、<code>{{recent}}</code> 刚才的观察、<code>{{said}}</code> 上次开口、<code>{{idle}}</code> 他的状态、<code>{{impNeed}}</code> 这一档的重要性门槛。不要的占位符可以直接删掉。
<button id="watch-prompt-reset" type="button" class="mini">恢复这一栏的默认</button></p>
<label for="subtitleSessData">B站登录信息（SESSDATA）</label>
<input id="subtitleSessData" type="password" autocomplete="off" maxlength="4096" placeholder="粘贴 SESSDATA 的值，或整段 SESSDATA=…；留空 = 不抓字幕">
<p class="hint">这是 B站登录凭证（一个 cookie），<b>不是账号密码</b>。填了之后看 B站视频，她会去抓「你现在播放位置前后两分钟」的字幕当参考，台词和剧情就能对上；留空就只看画面。</p>
<p class="hint"><b>怎么拿</b>：① 用浏览器打开 bilibili.com 并确认已登录；② 按 F12 打开开发者工具；③ 在 Edge 里点「应用程序 / Application」→ 左侧「Cookies / Cookie」→ <code>https://www.bilibili.com</code>；④ 在列表里找到名字是 <code>SESSDATA</code> 的那一行，复制它「值 / Value」那一列（一长串，里面有 <code>%2C</code> 之类的编码）。</p>
<p class="hint"><b>怎么填</b>：直接把那一长串值粘进来就行，要不要带 <code>SESSDATA=</code> 前缀都可以；粘整段 cookie 也行。填完点下面的保存。</p>
<p class="hint"><b>安全</b>：只存在本机配置文件里，只会发给 bilibili.com 自己的接口（拿字幕、看你看到哪了），不会发给别的服务，也不会写进日志。同学拿到就等于拿到了你这个账号的登录态，别外传。</p>
<p class="hint"><b>什么时候会失效</b>：B站过一阵会让登录态过期（退出登录也会）。如果她不提字幕了，先回这里换一个新的。另外只有本来就带字幕（CC / AI 字幕）的视频才抓得到，纯音乐、直播、很多老视频本来就没有。</p>
<label for="watchDetailPrompt">「回看」提示词（留空 = 用默认；占位符 <code>{{question}}</code>）</label>
<textarea id="watchDetailPrompt" rows="4" maxlength="4000" spellcheck="false" placeholder="留空则使用自带的默认提示词。"></textarea>
<p class="hint"><button id="watch-detail-reset" type="button" class="mini">恢复这一栏的默认</button></p>
<p class="hint">取景：<b>全屏</b> = 整屏都看；<b>自动</b> = 跟着最前面的那个窗口（每 5 秒看一次，换了就跟着换）；<b>窗口</b> = 只截你在下面选的那个。都只截那一块，裁剪在内存里做。</p>
<div class="pair"><label for="watchMode">取景</label><select id="watchMode"><option value="full">全屏</option><option value="auto">自动（跟着最前面的窗口）</option><option value="window">只截选定的窗口</option></select></div>
<div class="pair"><label for="watchWindowHwnd">选窗口（只有「窗口」模式用）</label><select id="watchWindowHwnd"><option value="0">（没选，按全屏）</option></select> <button id="watch-window-refresh" type="button" class="mini">刷新列表</button></div>
<p class="hint">突变（画面整块换掉）的判定：面积分要到多少、要比上一帧高几倍、两次之间至少隔几秒。数字越大越迟钝。</p>
<div class="pair"><label for="watchCutAbs">突变触发线（0–255）</label><input id="watchCutAbs" type="number" min="1" max="255" step="1"></div>
<div class="pair"><label for="watchCutSpike">要比上一帧高几倍</label><input id="watchCutSpike" type="number" min="1" max="20" step="0.1"></div>
<div class="pair"><label for="watchCutGapSec">突变最短间隔（秒）</label><input id="watchCutGapSec" type="number" min="0" max="60" step="0.1"></div>
<div class="pair"><label for="watchIntegralLight">轻变化灵敏度（越小越敏感）</label><input id="watchIntegralLight" type="number" min="0.5" max="100" step="0.5"></div>
<div class="pair"><label for="watchTalkGapSec">两次开口最短间隔（秒）</label><input id="watchTalkGapSec" type="number" min="2" max="3600" step="1"></div>
<div class="pair"><label for="watchFallbackSec">多久没说话必须说（秒）</label><input id="watchFallbackSec" type="number" min="10" max="36000" step="10"></div>
<div class="pair"><label for="watchStillWidth">兜底图宽（像素）</label><input id="watchStillWidth" type="number" min="320" max="4096" step="32"></div>
<div class="pair"><label for="watchStillHeight">兜底图高（像素）</label><input id="watchStillHeight" type="number" min="200" max="2560" step="20"></div>
<p class="hint">三档节奏：两次出图最短间隔（秒）/ 轻变化累计多少秒就出一张 / 完全没动时多久兜底一张。</p>
<div class="pair"><label for="watchCalmMinGapSec">轻 · 最短间隔</label><input id="watchCalmMinGapSec" type="number" min="1" max="3600" step="1"></div>
<div class="pair"><label for="watchCalmIntegralSec">轻 · 累计秒</label><input id="watchCalmIntegralSec" type="number" min="0.2" max="3600" step="0.5"></div>
<div class="pair"><label for="watchCalmFloorSec">轻 · 兜底秒</label><input id="watchCalmFloorSec" type="number" min="5" max="36000" step="5"></div>
<div class="pair"><label for="watchNormalMinGapSec">正常 · 最短间隔</label><input id="watchNormalMinGapSec" type="number" min="1" max="3600" step="1"></div>
<div class="pair"><label for="watchNormalIntegralSec">正常 · 累计秒</label><input id="watchNormalIntegralSec" type="number" min="0.2" max="3600" step="0.5"></div>
<div class="pair"><label for="watchNormalFloorSec">正常 · 兜底秒</label><input id="watchNormalFloorSec" type="number" min="5" max="36000" step="5"></div>
<div class="pair"><label for="watchDenseMinGapSec">密 · 最短间隔</label><input id="watchDenseMinGapSec" type="number" min="1" max="3600" step="1"></div>
<div class="pair"><label for="watchDenseIntegralSec">密 · 累计秒</label><input id="watchDenseIntegralSec" type="number" min="0.2" max="3600" step="0.5"></div>
<div class="pair"><label for="watchDenseFloorSec">密 · 兜底秒</label><input id="watchDenseFloorSec" type="number" min="5" max="36000" step="5"></div>
<div class="test-row"><button id="watch-stats-btn" type="button">看一眼最近 20 张</button><span id="watch-stats-status" class="test-result" role="status" aria-live="polite"></span></div>
<table id="watch-stats-table" hidden><thead><tr><th>时间</th><th>类型</th><th>分数</th><th>识图</th><th>说了没</th></tr></thead><tbody></tbody></table>
<p class="hint">面板读的是当天 <code>logs\陪伴\日期.jsonl</code>：分数是这一眼的变化分，识图是拿到笔记用了多久，「说了没」会写明是被间隔挡了还是她选择不说。</p>
</fieldset>
</div>
<p class="hint">改完保存会重启桌面小窗（约一秒），网页里的形象不受影响。</p>
<footer><button id="save" type="submit">保存设置</button><p id="status" role="status" aria-live="polite">正在读取设置…</p></footer>
</form></main></body></html>
`;

export const petSettingsStyle = `:root{--blue:#1b5f8a;--blue-soft:#edf5fa;--ink:#22313b;--muted:#6d7f8b;--line:#d8e3ea;--bg:#f6fafc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif}
main{max-width:760px;margin:28px auto;padding:0 18px 36px}header{padding:0 8px 16px}
.fish{font-size:26px;display:block;margin-bottom:8px}.local{margin:0;color:var(--muted);font-size:13px;letter-spacing:.04em}
h1{margin:4px 0 8px;font-size:27px;color:var(--blue)}.intro{margin:0;color:var(--muted);font-size:14px}
a{color:var(--blue)}form{background:#fff;border:1px solid var(--line);border-radius:12px;padding:6px 22px 16px;box-shadow:0 2px 10px rgba(27,95,138,.05)}
fieldset{border:0;border-top:1px solid var(--line);margin:0;padding:14px 0 6px}fieldset:first-of-type{border-top:0}
legend{font-weight:700;color:var(--blue);padding:0 0 2px}
label{display:block;margin:8px 0 3px;font-size:13px;color:var(--muted)}
input[type=text],input[type=number],input[type=url],input[type=password],textarea,select{width:100%;min-height:34px;padding:5px 9px;border:1px solid var(--line);border-radius:6px;font-size:14px;color:var(--ink);background:#fff}
textarea{min-height:110px;resize:vertical;font-family:inherit;line-height:1.55}
input:focus,select:focus{outline:2px solid var(--blue-soft);border-color:var(--blue)}
.pair{display:inline-block;width:calc(50% - 8px);vertical-align:top;margin-right:12px}
.pair:nth-of-type(even){margin-right:0}
label.check{display:flex;align-items:center;gap:8px;margin:10px 0 2px;color:var(--ink);font-size:14px}
label.check input{width:16px;height:16px}
.hint{color:var(--muted);font-size:12.5px;margin:10px 0 0;line-height:1.55}
.test-row{display:flex;align-items:center;gap:12px;margin:10px 0 2px;flex-wrap:wrap}
#test-btn{background:#fff;color:var(--blue);border:1.5px solid var(--blue);min-height:34px;padding:4px 16px;font-size:13.5px;border-radius:6px;cursor:pointer;font-weight:600}
.test-result{font-size:13px;flex:1 1 180px;min-height:20px}.test-success{color:#1a7f37;font-weight:600}.test-error{color:#cf222e}
footer{display:flex;align-items:center;gap:16px;margin-top:18px;flex-wrap:wrap}
#save{background:var(--blue);color:#fff;border:0;min-height:38px;padding:7px 24px;font-size:15px;border-radius:6px;cursor:pointer;font-weight:600}
#save:disabled{opacity:.6;cursor:wait}
button.mini{background:#fff;color:var(--blue);border:1.5px solid var(--blue);min-height:30px;padding:3px 12px;font-size:13px;border-radius:6px;cursor:pointer;font-weight:600;margin-top:6px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 2px;border-bottom:1px solid var(--line);padding-bottom:8px}
.tab{background:#fff;color:var(--muted);border:1px solid var(--line);border-radius:6px 6px 0 0;padding:5px 14px;font-size:13.5px;cursor:pointer;font-weight:600}
.tab.is-on{color:#fff;background:var(--blue);border-color:var(--blue)}
.tabpane{display:none}.tabpane.is-on{display:block}.mtabs{display:flex;gap:.35rem;margin:.2rem 0 .7rem}.mtab{border:1px solid #cbd5e1;background:#fff;border-radius:.55rem;padding:.28rem .8rem;font:inherit;font-size:.9rem;color:#475569;cursor:pointer}.mtab.is-on{background:#e0edff;border-color:#93c5fd;color:#1d4ed8;font-weight:600}.mpane{display:none}.mpane.is-on{display:block}
.gtabs{display:flex;gap:6px;margin:14px 0 0;flex-wrap:wrap}
.gtab{padding:7px 14px;border:1px solid var(--line);border-radius:8px 8px 0 0;background:#fff;color:var(--muted);font:inherit;cursor:pointer}
.gtab.is-on{background:var(--blue-soft);color:var(--blue);border-bottom-color:var(--blue-soft);font-weight:600}
.gpane{display:none}.gpane.is-on{display:block}
.hint-drag{position:relative;height:170px;margin:8px 0 4px;border:1px dashed var(--line);border-radius:10px;background:linear-gradient(180deg,#f6fbff,#eaf3fb);overflow:hidden;touch-action:none}
.hint-body{position:absolute;left:26px;top:34px;width:74px;height:104px;border-radius:10px;background:#cfe3f5}
.hint-body::after{content:"身体";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#5a6b84;font-size:12px}
.hint-bub{position:absolute;left:112px;top:46px;padding:3px 9px;border-radius:9px;background:rgba(18,34,58,.72);color:#eaf4ff;font-size:13px;cursor:grab;user-select:none;white-space:nowrap}
.hint-bub:active{cursor:grabbing}
/* 模型方案页签（哥哥 11-11 m19534）：选中即生效，所以做成"一排卡片"，不是下拉 */
.profile-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 4px}
.profile-row[hidden]{display:none}
.profile-label{font-size:13px;color:var(--muted);font-weight:600}
.ptabs{display:flex;gap:6px;flex-wrap:wrap}
.ptab{background:#fff;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 14px;font-size:13.5px;cursor:pointer;font-weight:600}
.ptab.is-on{color:#fff;background:var(--blue);border-color:var(--blue)}
.ptab:disabled{opacity:.55;cursor:default}
.profile-mini{background:#fff;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:12.5px;cursor:pointer}
.profile-mini:hover{color:var(--blue);border-color:var(--blue)}
#watch-stats-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px}
#watch-stats-table th,#watch-stats-table td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}
#watch-stats-table th{color:var(--muted);font-weight:600}#status{margin:0;font-size:13px;color:var(--muted);flex:1 1 200px}
#status[data-error=true]{color:#a13b30}#status[data-ok=true]{color:#1a7f37;font-weight:600}
@media(max-width:560px){main{margin:18px auto}.pair{width:100%;margin-right:0}footer{flex-direction:column;align-items:stretch}#save{width:100%}}
`;

export const petSettingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const get = (id) => document.getElementById(id);
  const form = get('settings');
  const save = get('save');
  const status = get('status');
  const testBtn = get('test-btn');
  const testResult = get('test-result');
  const PET = '/standalone-pet/settings';
  const AI = '/standalone-ai/settings';
  const PROFILES = '/standalone-pet/profiles';
  // 【汐儿 · 11-16】窗口列表的路由单独一个常量：之前这里手滑写了不存在的 ROUTE，
  // fetch 直接 ReferenceError，又被 loadWindows 里的空 catch 吞掉 → 下拉永远是空的。
  const WINDOWS = '/dsh-pet-7340/windows';
  // 【汐儿 · 11-16 m21833】提示气泡的偏移量：顶部声明，fillPet / 拖拽 / 提交都用这一份
  const hintPos = { x: 0, y: 0 };
  // 【汐儿 · 11-16 下午修】基准点也必须在这里声明：初始化时 showHint() 在 658 行之前就被调用过，
  // 原来 HINT_BASE 写在下面，const 的暂时性死区直接抛 ReferenceError，整个脚本当场死掉——
  // 表现就是「设置全都不见了 + 字号位置改了不生效」。别再把它挪回下面。
  const HINT_BASE = { left: 112, top: 46 };
  // 本地后端参数备忘（哥哥 11-03 报：本地 → 云端 → 再切回本地，地址和模型都被清空要重填）。
  // 服务端一次只存一种后端，切到云端后本地那份就从配置里消失了；页面这边切走前记一份、
  // 切回来时补回空栏即可。存在 localStorage，关掉设置页再打开也还在。
  const MEMO_KEY = 'body-of-fish.local-backend.memo';
  const memo = (() => {
    try { const raw = JSON.parse(localStorage.getItem(MEMO_KEY) || '{}'); return raw && typeof raw === 'object' ? raw : {}; }
    catch { return {}; }
  })();
  const saveMemo = () => { try { localStorage.setItem(MEMO_KEY, JSON.stringify(memo)); } catch { /* 无痕模式写不了，忽略 */ } };
  function message(text, kind) { status.textContent = text; status.dataset.error = String(kind === 'error'); status.dataset.ok = String(kind === 'ok'); }
  async function request(path, method, body) {
    const response = await fetch(path, {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
      if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || '保存失败，请稍后再试');
    }
    return response.json();
  }
  // 一页到底，但配置还是两份：外观/人格/看图/声音在宠物配置里，对话模型在 AI 设置里。
  // 页面是一次提交，脚本替用户分两次写——任何一步失败都明确报出来，不假装"都保存好了"。
  // 游戏陪伴那一组（数字框统一按 number 收）
  const WATCH_NUMBERS = ['watchCutAbs', 'watchCutSpike', 'watchCutGapSec', 'watchIntegralLight',
    'watchKeyGapSec', 'watchTalkGapSec', 'watchFallbackSec', 'watchCutWidth', 'watchCutHeight',
    'watchStillWidth', 'watchStillHeight', 'watchCalmMinGapSec', 'watchCalmIntegralSec', 'watchCalmFloorSec',
    'watchNormalMinGapSec', 'watchNormalIntegralSec', 'watchNormalFloorSec',
    'watchDenseMinGapSec', 'watchDenseIntegralSec', 'watchDenseFloorSec'];
  let watchDefaults = null;
  const texts = ['name', 'fontFamily', 'corner', 'persona', 'protocol', 'baseUrl', 'model',
    'visionMode', 'visionEndpoint', 'visionModel', 'voiceMode', 'voiceProtocol', 'voiceEndpoint',
    'voiceModel', 'voiceRefAudio', 'voicePromptText'];
  const numbers = ['size', 'marginX', 'marginY', 'fontSize', 'gravity', 'restitution', 'groundFriction',
    'throwPower', 'maxTokens'];
  const flags = ['desktopVisible', 'fixedEnabled', 'confineToScreen', 'followPet', 'ceilingBounce', 'enabled'];
  function fillPet(data) {
    for (const id of ['name', 'fontFamily', 'corner', 'persona', 'visionMode', 'visionEndpoint', 'visionModel',
      'visionBaseUrl', 'voiceMode', 'voiceProtocol', 'voiceEndpoint', 'voiceModel', 'voiceBaseUrl',
      'voiceRefAudio', 'voicePromptText', 'voiceVolume', 'voiceStaleSec', 'voiceGapMs',
      'earHotkey', 'peekHotkey', 'sayHotkey']) {
      const el = get(id); if (el && data[id] !== undefined) el.value = String(data[id]);
    }
    // 密钥不回显：只报「有没有」，输入框清空，勾选框复位
    for (const cap of ['vision', 'voice']) {
      const state = get(cap + '-key-state');
      if (state) state.textContent = data['has' + cap[0].toUpperCase() + cap.slice(1) + 'Key'] ? '已保存 · 不回显' : '沿用对话模型';
      const input = get(cap + 'ApiKey'); if (input) input.value = '';
      const clear = get('clear' + cap[0].toUpperCase() + cap.slice(1) + 'ApiKey'); if (clear) clear.checked = false;
    }
    for (const id of ['size', 'marginX', 'marginY', 'fontSize', 'gravity', 'restitution', 'groundFriction', 'throwPower']) {
      const el = get(id); if (el && data[id] !== undefined) el.value = String(data[id]);
    }
    for (const id of ['desktopVisible', 'fixedEnabled', 'confineToScreen', 'followPet', 'ceilingBounce']) {
      const el = get(id); if (el) el.checked = data[id] === true;
    }
    // 陪伴：四套提示词留空 = 用默认；数字原样回填；默认值留着给「恢复这一栏」
    for (const id of ['watchPrompt', 'watchPromptVideo', 'watchPromptWeb', 'watchPromptChat', 'watchDetailPrompt']) {
      const el = get(id); if (el) el.value = typeof data[id] === 'string' ? data[id] : '';
    }
    for (const id of WATCH_NUMBERS) {
      const el = get(id); if (el && data[id] !== undefined && data[id] !== null) el.value = String(data[id]);
    }
    const modeSel = get('watchMode');
    if (modeSel) modeSel.value = typeof data.watchMode === 'string' ? data.watchMode : 'auto';
    hintPos.x = Number(data.hintX ?? 0) || 0;
    hintPos.y = Number(data.hintY ?? 0) || 0;
    const hintSizeInput = get('hintSize');
    if (hintSizeInput) hintSizeInput.value = String(data.hintSize ?? 15);
    if (typeof showHint === 'function') showHint();
    const hwndSel = get('watchWindowHwnd');
    if (hwndSel && data.watchWindowHwnd !== undefined) {
      const want = String(data.watchWindowHwnd);
      if (want !== '0' && !Array.prototype.some.call(hwndSel.options, (o) => o.value === want)) {
        const opt = document.createElement('option');
        opt.value = want;
        opt.textContent = '（上次选的窗口 ' + want + '）';
        hwndSel.appendChild(opt);
      }
      hwndSel.value = want;
    }
    const mergeBox = get('mergeLook');
    if (mergeBox) mergeBox.checked = data.mergeLook !== false;
    const sess = get('subtitleSessData');
    if (sess) sess.value = typeof data.subtitleSessData === 'string' ? data.subtitleSessData : '';
    const defaults = data.watchPromptDefaults && typeof data.watchPromptDefaults === 'object' ? data.watchPromptDefaults : {};
    if (defaults.game || data.watchPromptDefault || data.watchDetailPromptDefault) {
      watchDefaults = {
        game: String(defaults.game || data.watchPromptDefault || ''),
        video: String(defaults.video || ''),
        web: String(defaults.web || ''),
        chat: String(defaults.chat || ''),
        detail: String(data.watchDetailPromptDefault || ''),
      };
    }
  }
  function fillAi(ai) {
    for (const id of ['protocol', 'baseUrl', 'model', 'maxTokens']) {
      if (ai[id] !== undefined) get(id).value = String(ai[id]);
    }
    get('enabled').checked = ai.enabled === true;
    get('key-state').textContent = ai.hasKey ? '已保存 · 不回显' : '尚未设置';
    if (get('extraHeaders')) get('extraHeaders').value = formatExtraHeaders(ai.extraHeaders);
    get('apiKey').value = '';
    get('clearApiKey').checked = false;
  }
  // 本地后端参数备忘：从本地切到云端前记下「本地地址 / 模型名」，切回本地时补回空栏
  function wireLocalMemo() {
    for (const cap of ['vision', 'voice']) {
      const mode = get(cap + 'Mode'); const endpoint = get(cap + 'Endpoint'); const model = get(cap + 'Model');
      if (!mode || !endpoint || !model) continue;
      const remember = () => {
        const saved = memo[cap] || {};
        memo[cap] = {
          endpoint: endpoint.value.trim() || saved.endpoint || '',
          model: model.value.trim() || saved.model || '',
        };
        saveMemo();
      };
      const restore = () => {
        const saved = memo[cap] || {};
        if (endpoint.value.trim() === '' && saved.endpoint) endpoint.value = saved.endpoint;
        if (model.value.trim() === '' && saved.model) model.value = saved.model;
      };
      let last = mode.value;
      if (last === 'local') remember(); // 页面一打开就是本地：先把现有值记一份
      mode.addEventListener('change', () => {
        if (last === 'local' && mode.value !== 'local') remember();
        if (mode.value === 'local') restore();
        last = mode.value;
      });
    }
  }
  function petBody() {
    const body = {
      name: get('name').value.trim(), size: Number(get('size').value),
      desktopVisible: get('desktopVisible').checked, fixedEnabled: get('fixedEnabled').checked,
      corner: get('corner').value, marginX: Number(get('marginX').value), marginY: Number(get('marginY').value),
      confineToScreen: get('confineToScreen').checked, fontFamily: get('fontFamily').value,
      fontSize: Number(get('fontSize').value), followPet: get('followPet').checked,
      hintX: Math.round(hintPos.x), hintY: Math.round(hintPos.y), hintSize: Number(get('hintSize').value),
      gravity: Number(get('gravity').value), restitution: Number(get('restitution').value),
      groundFriction: Number(get('groundFriction').value), throwPower: Number(get('throwPower').value),
      ceilingBounce: get('ceilingBounce').checked, persona: get('persona').value.trim(),
      visionMode: get('visionMode').value, visionEndpoint: get('visionEndpoint').value.trim(),
      visionModel: get('visionModel').value.trim(), voiceMode: get('voiceMode').value,
      visionBaseUrl: get('visionBaseUrl').value.trim(), clearVisionApiKey: get('clearVisionApiKey').checked,
      voiceProtocol: get('voiceProtocol').value, voiceEndpoint: get('voiceEndpoint').value.trim(),
      voiceModel: get('voiceModel').value.trim(), voiceRefAudio: get('voiceRefAudio').value.trim(),
      voicePromptText: get('voicePromptText').value.trim(),
      voiceVolume: Number(get('voiceVolume').value),
      voiceStaleSec: Number(get('voiceStaleSec').value),
      voiceGapMs: Number(get('voiceGapMs').value),
      voiceBaseUrl: get('voiceBaseUrl').value.trim(), clearVoiceApiKey: get('clearVoiceApiKey').checked,
      // 快捷键：留空 = 用默认（Alt+T / Alt+G / Alt+S），写成空串交给后端删键
      earHotkey: get('earHotkey').value.trim(), peekHotkey: get('peekHotkey').value.trim(),
      sayHotkey: get('sayHotkey').value.trim(),
      watchPrompt: get('watchPrompt') ? get('watchPrompt').value : undefined,
      watchMode: get('watchMode') ? get('watchMode').value : undefined,
      watchWindowHwnd: get('watchWindowHwnd') ? Number(get('watchWindowHwnd').value) : undefined,
      mergeLook: get('mergeLook') ? get('mergeLook').checked : undefined,
      watchPromptVideo: get('watchPromptVideo') ? get('watchPromptVideo').value : undefined,
      watchPromptWeb: get('watchPromptWeb') ? get('watchPromptWeb').value : undefined,
      watchPromptChat: get('watchPromptChat') ? get('watchPromptChat').value : undefined,
      watchDetailPrompt: get('watchDetailPrompt') ? get('watchDetailPrompt').value : undefined,
      subtitleSessData: get('subtitleSessData') ? get('subtitleSessData').value.trim() : undefined,
    };
    for (const id of WATCH_NUMBERS) {
      const el = get(id); if (el && el.value !== '') body[id] = Number(el.value);
    }
    // 密钥只在非空时提交（空 = 保留已保存的那把）
    const visionKey = get('visionApiKey').value; if (visionKey) body.visionApiKey = visionKey;
    const voiceKey = get('voiceApiKey').value; if (voiceKey) body.voiceApiKey = voiceKey;
    return body;
  }
  /** 「Key: Value」一行一条 → 对象；坏行忽略。 */
  function readExtraHeaders() {
    const out = {};
    const raw = get('extraHeaders') ? get('extraHeaders').value : '';
    String(raw).split(/\\r?\\n/u).forEach(function (line) {
      const text = line.trim();
      if (text === '') return;
      const at = text.indexOf(':');
      if (at <= 0) return;
      const key = text.slice(0, at).trim();
      const value = text.slice(at + 1).trim();
      if (key !== '') out[key] = value;
    });
    return out;
  }
  /** 对象 → 「Key: Value」多行，回填用。 */
  function formatExtraHeaders(headers) {
    if (!headers || typeof headers !== 'object') return '';
    return Object.keys(headers).map(function (k) { return k + ': ' + String(headers[k]); }).join('\\n');
  }
  function aiBody() {
    return {
      protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(), model: get('model').value.trim(),
      extraHeaders: readExtraHeaders(),
      apiKey: get('apiKey').value, clearApiKey: get('clearApiKey').checked,
      enabled: get('enabled').checked, maxTokens: Number(get('maxTokens').value),
    };
  }
  get('clearApiKey').addEventListener('change', () => {
    get('apiKey').disabled = get('clearApiKey').checked;
    if (get('clearApiKey').checked) { get('apiKey').value = ''; get('enabled').checked = false; }
  });
  if (testBtn && testResult) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.className = 'test-result';
      testResult.textContent = '正在测试连接，请稍候…';
      try {
        const response = await fetch('/standalone-ai/test', {
          method: 'POST', credentials: 'omit', cache: 'no-store',
          headers: { 'X-DSH-Pet-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(),
            model: get('model').value.trim(), apiKey: get('apiKey').value.trim() }),
        });
        const data = await response.json();
        if (data.ok) {
          testResult.className = 'test-result test-success';
          testResult.textContent = '✓ ' + data.message + (data.reply ? '（回复：' + data.reply + '）' : '');
        } else {
          testResult.className = 'test-result test-error';
          testResult.textContent = '✗ ' + (data.message || data.error || '测试失败');
        }
      } catch (error) {
        testResult.className = 'test-result test-error';
        testResult.textContent = '✗ 请求异常：' + (error && error.message ? error.message : String(error));
      } finally { testBtn.disabled = false; }
    });
  }
  async function load() {
    if (!token) throw new Error('请从桌宠菜单或本机启动器打开设置，以获得本次运行的访问凭据。');
    // 【汐儿 · 11-16 m22720】以前读宠物设置失败会被吞成空对象 → 表单退回默认值，
    // 哥哥在半空表单上点保存，等于拿一份残缺数据去撞校验。读不到就明说。
    const [ai, pet] = await Promise.all([request(AI, 'GET'), request(PET, 'GET')]);
    fillPet(pet);
    fillAi(ai);
    message('设置只在本机保存。', null);
  }
  async function doSave() {
    if (!form.reportValidity()) return false;
    save.disabled = true;
    message('正在保存…', null);
    const pet = petBody();
    const ai = aiBody();
    get('apiKey').value = '';
    try {
      // 两次写：宠物配置（外观/人格/看图/声音）与 AI 设置（对话模型）。失败就明说哪一步。
      const savedPet = await request(PET, 'POST', pet);
      try {
        const savedAi = await request(AI, 'POST', ai);
        fillPet(savedPet); fillAi(savedAi);
      } catch (error) {
        fillPet(savedPet);
        throw new Error('外观等已保存，但对话模型没存上：' + (error && error.message ? error.message : String(error)));
      }
      get('apiKey').disabled = false;
      // 顺手把这一套记回「方案」里（老版本没有这个接口，失败了也不影响保存本身）
      await request(PROFILES, 'POST', { action: 'snapshot' }).catch(() => null);
      message('已保存，桌面小窗正在重开', 'ok');
      return true;
    } catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); return false; }
    finally { save.disabled = false; }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); void doSave(); });
  // 隐藏页签里的必填项报错时用户看不见：先切到那一页，再让浏览器弹提示
  form.addEventListener('invalid', (event) => {
    const pane = paneOf(event.target);
    if (pane && pane !== currentPane) showPane(pane);
  }, true);
  // 【汐儿 · 11-11 m19534】模型方案：一排页签，点一下就整套换（对话 + 看图 + 声音）
  let activeProfileId = '';
  async function refreshSettings() {
    const [ai, pet] = await Promise.all([request(AI, 'GET'), request(PET, 'GET').catch(() => ({}))]);
    fillPet(pet); fillAi(ai);
  }
  function renderProfiles(data) {
    const tabs = get('profile-tabs');
    const row = get('profile-row');
    const hint = get('profile-hint');
    if (!tabs || !row) return;
    activeProfileId = String(data.activeId || '');
    tabs.textContent = '';
    for (const profile of Array.isArray(data.profiles) ? data.profiles : []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      const on = profile.id === activeProfileId;
      button.className = 'ptab' + (on ? ' is-on' : '');
      button.setAttribute('aria-selected', String(on));
      button.textContent = String(profile.name || profile.id);
      button.addEventListener('click', () => { void switchProfile(profile.id); });
      tabs.appendChild(button);
    }
    row.hidden = false;
    if (hint) hint.hidden = false;
  }
  async function loadProfiles() {
    try { renderProfiles(await request(PROFILES, 'GET')); }
    catch { /* 宿主模式 / 旧版本没有这个接口：这一排就不显示 */ }
  }
  async function switchProfile(id) {
    if (id === activeProfileId) return;
    // 先把当前这一套的改动存回去，再切——不然刚才改的东西会跟着页面一起丢掉
    if (!(await doSave())) return;
    message('正在换方案…', null);
    try {
      renderProfiles(await request(PROFILES, 'POST', { action: 'switch', id }));
      await refreshSettings();
      message('已经换成这套方案，桌面小窗正在重开', 'ok');
    } catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); }
  }
  const addBtn = get('profile-add');
  if (addBtn) addBtn.addEventListener('click', async () => {
    if (!(await doSave())) return;
    const name = window.prompt('新方案叫什么？（比如「DeepSeek」「本地」）', '方案 ' + (document.querySelectorAll('.ptab').length + 1));
    if (name === null) return;
    try {
      renderProfiles(await request(PROFILES, 'POST', { action: 'create', name }));
      await refreshSettings();
      message('新建了一套，后面改的都会存进这一套', 'ok');
    } catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); }
  });
  const renameBtn = get('profile-rename');
  if (renameBtn) renameBtn.addEventListener('click', async () => {
    if (!activeProfileId) return;
    const current = document.querySelector('.ptab.is-on');
    const name = window.prompt('改个名字', current ? current.textContent || '' : '');
    if (name === null) return;
    try { renderProfiles(await request(PROFILES, 'POST', { action: 'rename', id: activeProfileId, name })); message('改好了', 'ok'); }
    catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); }
  });
  const removeBtn = get('profile-remove');
  if (removeBtn) removeBtn.addEventListener('click', async () => {
    if (!activeProfileId) return;
    const current = document.querySelector('.ptab.is-on');
    if (!window.confirm('删掉「' + (current ? current.textContent : '这套') + '」？删了就找不回来了（设定还在另一套里）。')) return;
    try {
      renderProfiles(await request(PROFILES, 'POST', { action: 'remove', id: activeProfileId }));
      await refreshSettings();
      message('删掉了', 'ok');
    } catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); }
  });
  // 【汐儿 · 11-11 m19324】提示词分页签：点哪个显示哪一栏，其他不变
  const TAB_NAMES = { game: '游戏', video: '视频', web: '网页', chat: '聊天' };
  const PANE_INPUT = { game: 'watchPrompt', video: 'watchPromptVideo', web: 'watchPromptWeb', chat: 'watchPromptChat' };
  let activeTab = 'game';
  const tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  const tabPanes = Array.prototype.slice.call(document.querySelectorAll('.tabpane'));
  const MODEL_TABS = Array.prototype.slice.call(document.querySelectorAll('.mtab'));
  const MODEL_PANES = Array.prototype.slice.call(document.querySelectorAll('.mpane'));
  // 大项页签：外观 / 模型 / 陪伴 / 其他（【汐儿 · 11-15】哥哥说「挤在一起要滑很久」）
  const GPANES = ['look', 'model', 'watch', 'more'];
  let currentPane = 'look';
  function showPane(name) {
    if (GPANES.indexOf(name) < 0) name = 'look';
    currentPane = name;
    Array.prototype.slice.call(document.querySelectorAll('.gtab')).forEach(function (btn) {
      const on = btn.getAttribute('data-gtab') === name;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.slice.call(document.querySelectorAll('.gpane')).forEach(function (pane) {
      pane.classList.toggle('is-on', pane.getAttribute('data-gpane') === name);
    });
  }
  // 有必填项没填时，浏览器只会在隐藏页签里报错、用户看不见 → 先把出问题的页签切出来
  function paneOf(el) {
    const pane = el.closest ? el.closest('.gpane') : null;
    return pane ? pane.getAttribute('data-gpane') : '';
  }
  function showVolume() {
    const out = get('voiceVolumeOut');
    const input = get('voiceVolume');
    if (out && input) out.textContent = input.value === '100' ? '原声' : (input.value === '0' ? '静音' : input.value);
  }
  Array.prototype.slice.call(document.querySelectorAll('.gtab')).forEach(function (btn) {
    btn.addEventListener('click', function () { showPane(btn.getAttribute('data-gtab')); });
  });
  const volumeInput = get('voiceVolume');
  if (volumeInput) volumeInput.addEventListener('input', showVolume);
  showPane('look');
  showHint();

  // 【汐儿 · 11-16 m21257】窗口下拉：现列一次（只列有标题、够大的窗口）
  async function loadWindows() {
    const sel = get('watchWindowHwnd');
    if (!sel) return;
    try {
      const res = await fetch(WINDOWS, { headers: { 'x-dsh-pet-token': token } });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.windows) ? data.windows : [];
      const keep = sel.value;
      sel.innerHTML = '<option value="0">（没选，按全屏）</option>';
      list.forEach((w) => {
        const opt = document.createElement('option');
        opt.value = String(w.hwnd);
        opt.textContent = String(w.title || w.exe || '') + '（' + String(w.exe || '') + '）';
        sel.appendChild(opt);
      });
      sel.value = keep;
      if (sel.value !== keep) sel.value = '0';
    } catch (error) {
      /* 列表拉不到不影响保存 */
    }
  }
  const winRefresh = get('watch-window-refresh');
  if (winRefresh) winRefresh.addEventListener('click', () => { void loadWindows(); });
  void loadWindows();

  // 【汐儿 · 11-16 m21833】提示气泡：字号滑杆 + 拖预览改位置（偏移量存配置，渲染层照着摆）
  function showHint() {
    const bub = get('hintBub');
    const sizeInput = get('hintSize');
    if (sizeInput) {
      const out = get('hintSizeOut');
      if (out) out.textContent = sizeInput.value + 'px';
    }
    if (!bub) return;
    bub.style.left = HINT_BASE.left + hintPos.x + 'px';
    bub.style.top = HINT_BASE.top + hintPos.y + 'px';
    if (sizeInput) bub.style.fontSize = sizeInput.value + 'px';
  }
  (function bindHintDrag() {
    const box = get('hintDrag');
    const bub = get('hintBub');
    if (!box || !bub) return;
    let drag = null;
    bub.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      bub.setPointerCapture(ev.pointerId);
      drag = { x: ev.clientX, y: ev.clientY, ox: hintPos.x, oy: hintPos.y };
    });
    bub.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      // 【汐儿 · 11-16 体检 B4】边界必须和 schema 完全一致（hint.x / hint.y 都是 ±400）：
      // 以前上限按预览框宽度算（能拖到 448），拖偏一点保存就被判「桌宠设置无效」。
      // 取整也在这里做：clientX 是小数，带小数点的偏移量同样会让整份设置被拒。
      const clampHint = function (value, lo, hi) {
        return Math.round(Math.max(lo, Math.min(hi, value)));
      };
      hintPos.x = clampHint(drag.ox + (ev.clientX - drag.x), -400, 400);
      hintPos.y = clampHint(drag.oy + (ev.clientY - drag.y), -400, 400);
      showHint();
    });
    const stop = function () { drag = null; };
    bub.addEventListener('pointerup', stop);
    bub.addEventListener('pointercancel', stop);
    const sizeInput = get('hintSize');
    if (sizeInput) sizeInput.addEventListener('input', showHint);
  })();

  function showModelTab(name) {
    MODEL_TABS.forEach((tab) => {
      const on = tab.dataset.mtab === name;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
    });
    MODEL_PANES.forEach((pane) => pane.classList.toggle('is-on', pane.dataset.mpane === name));
  }
  MODEL_TABS.forEach((tab) => tab.addEventListener('click', () => showModelTab(tab.dataset.mtab ?? 'chat')));

function showTab(name) {
    activeTab = name;
    tabButtons.forEach((el) => {
      const on = el.getAttribute('data-tab') === name;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-selected', String(on));
    });
    tabPanes.forEach((el) => el.classList.toggle('is-on', el.getAttribute('data-pane') === name));
  }
  tabButtons.forEach((el) => el.addEventListener('click', () => showTab(String(el.getAttribute('data-tab')))));
  // 恢复这一栏的默认：把内置默认全文填进框里（保存后就是自定义，和空串一个效果）
  const resetBtn = get('watch-prompt-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!watchDefaults) { message('还没读到默认提示词，稍等一下再点', 'error'); return; }
    const input = get(PANE_INPUT[activeTab]);
    if (!input) return;
    input.value = watchDefaults[activeTab] || '';
    message('「' + (TAB_NAMES[activeTab] || activeTab) + '」的默认已填入，记得点保存', 'ok');
  });
  const detailReset = get('watch-detail-reset');
  if (detailReset) detailReset.addEventListener('click', () => {
    if (!watchDefaults) { message('还没读到默认提示词，稍等一下再点', 'error'); return; }
    if (get('watchDetailPrompt')) get('watchDetailPrompt').value = watchDefaults.detail || '';
    message('「回看」的默认已填入，记得点保存', 'ok');
  });
  // 结果面板（哥哥 m18312）：最近 20 张图的分数 / 识图耗时 / 有没有说话
  const statsBtn = get('watch-stats-btn');
  const statsTable = get('watch-stats-table');
  const statsStatus = get('watch-stats-status');
  const REASON_TEXT = { cut: '突变', mark: '累计', floor: '兜底' };
  const DROP_TEXT = { gap: '间隔没到', busy: '手上忙', nothing: '她不想说', slow: '太慢了' };
  async function loadStats() {
    if (!statsBtn || !statsTable) return;
    statsBtn.disabled = true;
    if (statsStatus) { statsStatus.className = 'test-result'; statsStatus.textContent = '正在读…'; }
    try {
      const response = await fetch('/dsh-pet-7340/watch-stats', { headers: { 'X-DSH-Pet-Token': token }, cache: 'no-store' });
      const data = await response.json();
      const rows = Array.isArray(data.entries) ? data.entries : [];
      const tbody = statsTable.querySelector('tbody');
      tbody.textContent = '';
      for (const row of rows) {
        const tr = document.createElement('tr');
        const said = row.said ? '说了：' + row.said : '没说（' + (DROP_TEXT[row.drop] || row.drop || '—') + '）';
        const cells = [
          String(row.t || '').replace('T', ' ').slice(11, 19),
          REASON_TEXT[row.reason] || row.reason || '—',
          row.score === undefined || row.score === null ? '—' : String(row.score),
          row.noteMs === undefined || row.noteMs === null ? '—' : (row.noteMs / 1000).toFixed(1) + 's',
          said,
        ];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      statsTable.hidden = rows.length === 0;
      if (statsStatus) statsStatus.textContent = rows.length === 0 ? '今天还没有出过图' : '最近 ' + rows.length + ' 张';
    } catch (error) {
      if (statsStatus) { statsStatus.className = 'test-result test-error'; statsStatus.textContent = '读不到：' + (error && error.message ? error.message : String(error)); }
    } finally { statsBtn.disabled = false; }
  }
  if (statsBtn) statsBtn.addEventListener('click', () => { loadStats().catch(() => {}); });
  wireLocalMemo();
  load().then(() => loadStats()).then(() => loadProfiles()).catch((error) => message(error instanceof Error ? error.message : String(error), 'error'));
})();
`;
