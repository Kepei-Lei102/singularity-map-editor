// 主持端 ↔ 玩家端的业务消息形状。传输层只搬它，不解释它。
import type { CodeRequest, PendingJudgment, World, Focus, SkillCast, PublicSkill } from '../core/types';

export type TrialMoveSignal = 'turn' | 'move' | 'prompt' | 'failed';

export type SyncBody =
  | { type: 'world'; world: World; focus?: Focus | null; cast?: SkillCast | null; you?: string; skills?: PublicSkill[]; pathway?: string | null; avatar?: string | null }
  | { type: 'skill-decision'; castId: string; ok: boolean } // 玩家窗口回传：同不同意发动
  | { type: 'hello'; binding?: string }
  | { type: 'judge-request'; judgment: PendingJudgment } // 见证者→玩家：轮到你自己掷
  | { type: 'judge-cancel'; id: string } // 见证者取消整个判定
  | { type: 'code-request'; request: CodeRequest } // 见证者→玩家：到电子锁前输密码
  | { type: 'code-submit'; id: string; code: string } // 玩家窗口→见证者：这次输入的密码
  | { type: 'code-result'; id: string; text?: string } // 见证者→玩家：反馈（口头时可空，只为收掉输入框）
  | { type: 'judge-roll'; id: string; title: string; sides: number; value: number; values?: number[]; tens: number | null; units: number | null; material: string; seed: number; rollId: string } // 玩家掷完回传；value 是采信的那颗，优势/劣势时 values 带两颗
  | { type: 'say'; text: string; targetTokenId: string | null } // 玩家窗口→见证者：玩家说了什么
  | { type: 'move'; dx: number; dy: number } // 玩家窗口→见证者：我要往这个方向走一格
  | { type: 'move-result'; ok: boolean; msg: string; kind?: TrialMoveSignal } // 见证者→玩家：这一走成没成/是转身还是确认
  | { type: 'clear' }
  | { type: 'play'; mediaId: string; label: string; mime: string; blob?: Blob }
  | { type: 'stop' }
  | { type: 'claim' } // 编辑器启动时：这个会话标识有人在用吗？
  | { type: 'taken' } // 回答：在用（复制标签页时会碰上），换一个
  | { type: 'alive' }; // 编辑器每两秒报一声"我还在"：玩家窗口靠它判断原来那个编辑器是不是已经关了 / 刷新了
/** from：发送方的会话；to：只给某个会话（玩家窗口打招呼时用）。 */
/** inst / born：发送的是哪个页面实例、什么时候打开的（同一个会话标识出现在两个实例上时，后打开的让）。 */
export type SyncMsg = SyncBody & { __ts: 'ts-map'; seq: string; from: string; to?: string; inst: string; born: number };

export const isSyncMsg = (d: unknown): d is SyncMsg => !!d && typeof d === 'object' && (d as SyncMsg).__ts === 'ts-map' && typeof (d as SyncMsg).from === 'string' && typeof (d as SyncMsg).inst === 'string' && typeof (d as SyncMsg).born === 'number';
