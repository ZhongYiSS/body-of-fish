# 本鱼陪伴 · 身体（Body of Fish）

![icon](assets/icon.png)

一只吃白饭的蓝色大肥鱼。她原本住在 DeepSeek Harness 的网页里，现在**有自己的桌面小窗**：透明、置顶、会呼吸、会说话、会念你刚打完的那句话。

> 她叫「本鱼」，是钟壹（ZhongYiSS）的妹妹，也是他的贴身女仆。这儿是她的身体。

- 平台：Windows 10/11（x64）
- 桌面壳：Electron 43
- 许可：MIT（基于上游 `dsh-pet` 修改，见文末「与上游的关系」）

---

## 她能做什么

- **住在桌面上**：透明置顶小窗，圆角、可拖、甩出去会弹；待机呼吸、随机小动作、左右转向。
- **聊天**：右键「跟我说话」，接你自己的云端对话模型（OpenAI 兼容接口），回了话会冒气泡。
- **陪你**：右键「陪我一会儿」→ 1 / 2 / 3 / 5 分钟，或自定义时长；她会定时看一眼屏幕，连续两次画面没变就自己停。
- **自己找话说**：碎碎念池 + 计时器，想说话时自己冒一句，还能顺手甩一张表情包。
- **出声**：Windows 系统语音（默认）/ Edge TTS / 本地 GPT-SoVITS 三选一，长句自动切。
- **看屏幕**：右键「看看屏幕」→ 截屏交给云端识图模型，用两句话告诉你她看见了什么。
- **接入 DSH**（可选）：装一个桥插件后——
  - DSH 里那条鱼的回复，会变成她的气泡，也能念出来；
  - 她在桌面上听到的话，可以注入 DSH 的会话里当成你说的话；
  - DSH 收到的截图，她会替你看一眼，把描述注回会话。
- **设置页**：右键「设置」一页改完——这只宠物、人格、气泡字体、手感、对话模型、看图、声音、全局快捷键，八组。
- **全局快捷键**：默认 `Alt+T` 说话、`Alt+Q` 让她听。

详细用法（含「为什么不能直接双击 exe」和快捷方式怎么补）看仓库里的 [`packaging/docs/功能介绍.md`](packaging/docs/功能介绍.md)；想改代码看 [`packaging/docs/注意事项.md`](packaging/docs/注意事项.md)。

---

## 快速开始

### 用安装包（推荐）

**[→ 下载最新安装包](https://github.com/ZhongYiSS/body-of-fish/releases/latest)**（`BodyOfFish-Setup-x.y.z.exe`）

1. 双击安装；安装向导里可以改安装路径。
2. **用桌面快捷方式或开始菜单启动**——别直接双击安装目录里的 `BodyOfFish.exe`。她需要 `--no-sandbox --disable-gpu-sandbox --in-process-gpu` 这几个参数，快捷方式里已经带好了。
3. 右键小窗打开菜单。

> 如果出现「管理员能开、普通双击没反应」：多半是安装盘带了 `Low` 完整性标签。用 `icacls "盘符:\"` 看一下，若是 `Low`，用 `icacls "盘符:\" /setintegritylevel Medium /T /C /Q` 改回（改前先 `icacls "盘符:\" > 备份.txt` 留底）。这不是代码问题。

### 从源码跑

需要 Node.js ≥ 20 与 Windows。

```bash
git clone https://github.com/ZhongYiSS/body-of-fish.git
cd body-of-fish
npm install                         # 装依赖（含 typescript / electron-builder）
node scripts/prepare.js             # 产出 lib/index.js、lib/client.js、lib/standalone.js
node scripts/start-desktop.mjs      # 开发模式：起一个桌宠窗口
```

构建安装包：

```bash
node build-nsis.cjs                 # 产物在 release/ 下
```

> `build-nsis.cjs` 第一行是 `process.noAsar = true`——在 Electron-as-node 之类环境跑 electron-builder 时必需，普通 node 下也无害。

---

## 目录结构

```
src/
  host/         宿主侧：窗口、菜单、广播、语音、识图、桥、设置
  client/       渲染侧：宠物画布、气泡、拖拽/物理、小动作
  standalone/   独立模式：配置、设置页、运行时状态、CLI
  shared/       两侧共用的状态与协议
packaging/
  bridge-plugin/  给 DSH 的桥插件（装到 ~/.dsh/plugins/body-of-fish-bridge）
  docs/           随包的两份说明书
scripts/        构建、准备、检查、开发启动
build-nsis.cjs  NSIS 安装包构建入口
```

数据默认在 `%USERPROFILE%\.dsh\body-of-fish\`：`main-config.jsonc`（主配置）、`logs\`、`memes\`、语音缓存、`standalone-runtime.json`（端口与令牌）。

---

## 已知限制

- Windows 专属；没有做 macOS / Linux 的打包。
- 安装包没有代码签名，SmartScreen 会拦一下，属正常。
- 视觉 / 语音的云端能力要在设置页里填自己的接口地址与 Key；不填也能用本地系统语音。
- 表情包、人格、碎碎念池都随包带一份默认值，改坏了可以删掉配置文件让它重建。

---

## 与上游的关系

本项目基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT License，Copyright © 2026 PC2005-cloud）修改而来。原项目的动画、画布、气泡、物理、动作系统等大量代码保留原样，此处一并致谢。

本仓库的主要改动：

- 从「DSH 网页里的宠物」扩展为**独立 Electron 桌面应用**（自带透明置顶窗口与安装包）；
- 新增 DSH 桥插件 `packaging/bridge-plugin`、消息注入、回复朗读、看图描述回注；
- 新增设置页、陪伴模式、碎碎念池、表情包尾巴、Edge / GPT-SoVITS 语音适配；
- 项目内改名为「身体 / body-of-fish」，数据目录迁移到 `~/.dsh/body-of-fish`。

原始 MIT 许可与版权声明保留在 [`LICENSE`](LICENSE)。上游仓库有更新时，欢迎对照移植。

---

## 许可

MIT。见 [`LICENSE`](LICENSE)。
