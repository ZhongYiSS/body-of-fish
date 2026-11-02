/**
 * PetCore —— 桌宠的**唯一业务边界**。
 *
 * 【为什么要有它】改造前，业务逻辑只有一条路能进来：`handlePetRoute(url, method, body)`
 * 这个吃 HTTP 字符串的函数。于是任何"自己人"想说话、想播动画，都必须先拼一个
 * `POST http://127.0.0.1:<port>/dsh-pet-7340/broadcast?pet=main&surface=desktop`
 * 发出去（附属插件 dsh-pet-extras 全这么干）：多一次序列化、多一次回环、端口写死、
 * 端口一变就全哑。PetCore 把"能力"和"传输"分开：
 *
 *   业务实现（本文件背后的实现）→ PetCore
 *      ├─ HTTP 路由  /dsh-pet-7340/*      （外部/浏览器/脚本，保持原样）
 *      └─ 桌面管道   dsh-pet-bridge://    （Electron 壳，保持原样）
 *   同进程的 partner（六个 fish 模块）= 直接 `core.say(...)`，不过网络。
 *
 * 【铁律】
 * 1. **读零副作用**：`config()` / `state()` 只读快照，绝不顺手写叶子、绝不打日志刷屏。
 * 2. **写必过叶子**：所有"指令"最终落到 `pets.<id>.<name>` 的 `{counter, data}` 上，
 *    并让顶层 counter 递增——长轮询靠这一个数字醒来，绕过去就等于让前端卡住。
 * 3. **本文件不许 import src/shared**：DSH 的单文件加载约束会把 shared 拆成 chunk 导致
 *    插件加载失败（源码头注释里写着这条坑）。宿主侧的 cue 类型因此与 shared 侧是**两份**，
 *    由 `pet-core.test.ts` 的源码守卫钉住"字面量必须一致"。
 * 4. 这里只有**类型**，没有实现。P2 才把现有 handlePetRoute 拆成 core + 传输适配。
 */

/** 一只宠物的 id（配置里的键，允许含点号——所以状态路径一律当不透明字符串，不解析） */
export type PetId = string;

/** 被驱动的那一面：桌面小窗（desktop）还是浏览器浮层（web）。老版本只有 desktop。 */
export type PetSurface = 'desktop' | 'web';

/** 朝向：left = 素材原样，right = 镜像。（与 shared 侧 `PetFacing` 必须字面量一致） */
export type PetFacing = 'left' | 'right';

/**
 * 说话指令 —— 对应路由 `/broadcast`（弹气泡）与 `/bubble/clear`（收起）。
 *
 * `image` = 表情包名字（消费端自己拼素材路径），`url` = 第三方完整地址；
 * 两者并列、由字段名区分，**不许**塞进一个中性字段再用 `startsWith('http')` 嗅探。
 * `duration` 毫秒，缺省 10s，`0` = 字面意思"不显示"。`anim: false` = 只弹气泡、不联动动画。
 */
export type SayCue =
  | {
      kind: 'say';
      text: string;
      image?: string;
      url?: string;
      duration?: number;
      anim?: boolean;
    }
  | { kind: 'clear' };

/**
 * 点播动画 —— 对应 `/anim`。`name` 在该宠物动画池内，`url` 是第三方完整地址；
 * 恰好给一个。`facing` 缺省 = **不动朝向**（不是回落 left）。
 * 返回值是宿主受理时生成的回执编号，渲染端在播放的四个时机拿它上报真实状态（`/playback`）。
 */
export interface AnimCue {
  name?: string;
  url?: string;
  facing?: PetFacing;
}

/**
 * 播放状态 —— 对应 `/playback`。宿主据此知道"这段动画到底播没播成"。
 * 取值与 `src/host/playback.ts` 的 `PlaybackStatus` **完全一致**（那里是唯一权威：
 * `accepted` 由宿主写、其余四个由渲染端上报；`ended` / `failed` / `cancelled` 是终态）。
 */
export type PlaybackStatus = 'accepted' | 'playing' | 'ended' | 'failed' | 'cancelled';

/** 位置指令 —— 对应 `/position`。x/y 是宠物**中心**的归一化坐标（0~1，写前已夹取）。 */
export type PositionCue =
  | { x: number; y: number; mode: 'instant' }
  | { x: number; y: number; mode: 'spring' }
  /** line 模式必须带时长（毫秒），缺了就是非法指令 */
  | { x: number; y: number; mode: 'line'; duration: number };

/** 抛掷指令 —— 对应 `/throw`。`angle` 单位度（0 = 正右，逆时针为正），`power` 力度倍率。 */
export interface ThrowCue {
  angle: number;
  power: number;
}

/** 占用请求 —— 对应 `/lock`。宿主只把 `{locked:true, expiresAt}` 写进人人可读的 /state。 */
export interface LockRequest {
  /** 占用时长（毫秒），到点懒判过期 */
  ttlMs: number;
  /** 谁占的（写进宿主日志，不进 /state） */
  owner?: string;
}

/** 占用回执：`lockId` 是持锁者凭证，**绝不**放进 /state（那是所有人可读的）。 */
export interface LockReceipt {
  lockId: string;
  expiresAt: number;
}

/** 一个状态叶子：计数器 + 载荷（data 为 null = 还没有数据，消费端跳过这一拍）。 */
export interface StateLeaf {
  counter: number;
  data: unknown;
}

/**
 * `/state` 的服务端形状。
 *
 * - `sections`：全局槽位（balance / workStatus / notify ...）；
 * - `pets`：每只宠物一桶，桶里是 say / anim / lyric / lock / playback ...
 * - 顶层 `counter`：最后一次写入的编号，长轮询 `?since=&timeout=` 拿它比。
 */
export interface PetStateView {
  counter: number;
  sections: Record<string, StateLeaf>;
  pets: Record<string, Record<string, StateLeaf>>;
}

/** 保存配置的结果（对应 `PUT /config` 的三种结局）。 */
export type SaveConfigResult =
  | { ok: true; config: unknown }
  | { ok: false; reason: 'invalid'; error: string }
  /** 用户文件真损坏：先不写盘，等调用方确认（对应 HTTP 409 + needConfirm） */
  | { ok: false; reason: 'unparsable'; error: string; userFile: string };

/** 宿主主动广播出去的内部事件（同进程 partner 用 on() 订阅）。 */
export interface PetCoreEvents {
  /** 宠物说了话（碎碎念 / 对话回复 / 命令气泡都走这一条） */
  say: { petId: PetId; text: string; surface?: PetSurface };
  /** 用户点了菜单项（原本走 POST /menu/events，partner 以前得自己轮询/接路由） */
  'menu:event': { petId: PetId; action: string; payload?: unknown };
  /** 配置被保存过（设置页 / PUT /config / 同步默认） */
  'config:changed': { source: 'put' | 'sync-default' | 'file' };
  /** 桌面 Helper 起落（壳挂了 / 重启完） */
  'desktop:state': { alive: boolean; reason?: string };
}

/**
 * 桌宠业务能力的**全部**对外形状（实现见 P2）。
 *
 * 一句话对照表（旧 → 新）：
 *   POST /broadcast            → core.say(petId, {kind:'say',...})
 *   POST /bubble/clear         → core.say(petId, {kind:'clear'})
 *   POST /anim                 → core.anim(petId, cue) → { playbackId }
 *   POST /playback             → core.reportPlayback(petId, { playbackId, status })
 *   POST /position | /throw    → core.move(petId, cue) / core.throwPet(petId, cue)
 *   POST /lock  | /lock/release→ core.lock(petId, req) / core.unlock(petId, lockId)
 *   GET  /state                → core.state()
 *   GET  /config               → core.config()
 *   PUT  /config               → core.saveConfig(patch)
 *   POST /lyric                → core.writeSection('lyric', data)   ← 本鱼补的那条
 *   POST /reload               → core.reload()
 */
export interface PetCore {
  /** 成品配置快照（合并后的绝对正确结果，不是磁盘原文）。只读、零副作用。 */
  config(): unknown;

  /** 状态快照。只读、零副作用；**不要**在这里顺手写叶子。 */
  state(): PetStateView;

  /** 宠物说一句话（或收起气泡）。 */
  say(petId: PetId, cue: SayCue, surface?: PetSurface): void;

  /** 点播一段动画，返回回执编号（渲染端拿它上报播放阶段）。 */
  anim(petId: PetId, cue: AnimCue, surface?: PetSurface): { playbackId: string };

  /** 播放状态上报（playing / ended / failed / cancelled；accepted 由宿主自己写）。 */
  reportPlayback(petId: PetId, report: { playbackId: string; status: PlaybackStatus }): void;

  /** 挪动宠物（instant / spring / line 三种）。 */
  move(petId: PetId, cue: PositionCue): void;

  /** 把宠物甩出去。 */
  throwPet(petId: PetId, cue: ThrowCue): void;

  /** 占用宠物（到点自动失效）。 */
  lock(petId: PetId, req: LockRequest): LockReceipt;

  /** 释放占用（凭证不对 = 静默无效，不抛）。 */
  unlock(petId: PetId, lockId: string): void;

  /**
   * 通用槽位写入：`writeSection(name, data)` 落到 `sections.<name>`，
   * `writePetSection(petId, name, data)` 落到 `pets.<id>.<name>`。
   * 这是 partner 最常用的入口（记忆同步、歌词、工作状态都走这里），**没有**对应新路由也要能用。
   */
  writeSection(name: string, data: unknown): void;
  writePetSection(petId: PetId, name: string, data: unknown): void;

  /** 保存用户层配置。 */
  saveConfig(patch: unknown, options?: { force?: boolean }): Promise<SaveConfigResult>;

  /** 重载（重读配置 + 重解析桌面宠物），对应 POST /reload。 */
  reload(): Promise<void>;

  /** 订阅宿主事件，返回取消订阅函数。 */
  on<K extends keyof PetCoreEvents>(event: K, handler: (payload: PetCoreEvents[K]) => void): () => void;
}
