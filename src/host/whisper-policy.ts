/**
 * 碎碎念什么时候该说（纯函数，零 IO）。
 *
 * 【本鱼改造 · 10-30 本地化】哥哥要的是「碎碎念 100% 本地、不走云端、不消耗 token」。
 * 改造前的口径是：独立模式下必须 `isReady() && canWhisper()` 同时为真才排期——这两个都建立在
 * **云端接口配全**之上。结果就是：池子里明明写着 50 句话，没配 key 就一句都不说，本地化白做。
 *
 * 现在的口径分两道闸，各管一件事：
 *  - 要不要说：宠物自己的 `whisperEnabled`（`petEnabled`）——**唯一**的用户开关；
 *  - 多久说一次：宠物配置的 `eventsRefreshSec.whisper`（`configuredPeriodSec`）——
 *    右键菜单和设置页改的都是它，**不再有第二份间隔**（那份 AI 设置页的 whisperIntervalSec
 *    曾经各存一个值，改了菜单却不生效，属于同一个 bug 的两个面）；
 *  - 需不需要模型：池里有句子 = 只抽卡，**不需要** `isReady()`；池子空了才要求云端配全。
 * 这样两条路互不牵连：池子有货 → 不花钱也能说；池子没货 → 要么走模型（配了 key），
 * 要么安静（没配就闭嘴，不报错）。
 *
 * 注：`canWhisper()` / `whisperIntervalSec()` 仍留在接口里（实现方与旧测试还在用），
 * 但排期**不再读它们**——留着只为不连锁改动，别再往它们上面加逻辑。
 */
export interface StandaloneWhisperPolicy {
  isReady(): boolean;
  canWhisper(): boolean;
  whisperIntervalSec(): number;
}

/**
 * 随机浮动比例：每拍在 [1-JITTER, 1+JITTER] 之间抖动。
 *
 * 为什么要抖：固定周期会让碎碎念像打卡（每 5 分钟整点冒一句），观感很机械；
 * 而且一排只宠物同时开的时候会整齐划一地一起冒泡。±20% 足够打散。
 */
export const WHISPER_JITTER = 0.2;

export interface WhisperScheduleOptions {
  /** 本地碎碎念池里有没有可用条目（有 → 不需要模型就绪） */
  hasLocalPool?: boolean;
  /** 注入随机源（测试用；缺省 Math.random） */
  random?: () => number;
}

/**
 * 算出「这只宠物这一拍该不该说、下次隔多久」。
 *
 * @param policy 独立模式的策略；undefined = DSH 宿主（沿用宠物自己的 whisperEnabled）
 * @param petEnabled 宠物级的 whisperEnabled
 * @param configuredPeriodSec 配置里的周期（秒）
 * @param options.hasLocalPool 本地池是否有货
 * @param options.random 随机源（只影响抖动，不影响 enabled）
 */
export function automaticWhisperSchedule(
  policy: StandaloneWhisperPolicy | undefined,
  petEnabled: boolean,
  configuredPeriodSec: number,
  options: WhisperScheduleOptions = {},
): { enabled: boolean; periodSec: number } {
  const jitter = (base: number): number => {
    const random = options.random ?? Math.random;
    const factor = 1 - WHISPER_JITTER + random() * WHISPER_JITTER * 2;
    // 夹紧发生在**抖动之后**：60 秒是防连发的硬下限（配置写 0/负数时也靠它兜底），
    // 只夹 before 的话 0.8×60=48 又把下限吃回去了，等于抖动偷偷放开了限制。
    return Math.max(60, base * factor);
  };
  // DSH 宿主：沿用原来的口径（只看宠物开关 + 配置周期），不掺抖动——
  // 那是插件模式的老行为，主人（哥哥）没让改，改了反而不好对账。
  if (!policy) return { enabled: petEnabled, periodSec: configuredPeriodSec };
  const base = Number.isFinite(configuredPeriodSec) ? Math.max(60, configuredPeriodSec) : 300;
  // 池里有句子 → 绕开的是「云端就绪」这一道，不是用户的开关：
  // 说与不说由宠物自己的 `whisperEnabled`（petEnabled）决定；池子空着、真要回模型时，
  // 才额外要求 `isReady()`——独立版池空本来就直接安静（publishWhisper 不回落模型）。
  const canSay = options.hasLocalPool === true || policy.isReady();
  return { enabled: petEnabled && canSay, periodSec: Math.round(jitter(base)) };
}
