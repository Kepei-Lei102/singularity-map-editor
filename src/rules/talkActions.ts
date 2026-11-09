// 白卡默认的交流动作（原始动作里的「交流」一类）。
//
// 来源：《奇点之后》动作库 V2.1.1(2).xlsx · 原始动作（白卡默认）页签。
// 这 10 个是人人都能做的，不消耗 ME。技能版是它们的增强版，以后挂上去。
//
// 它们和对话骨架是同一件事：玩家说了一句话，见证者把它接成这里的某一个。
// 注意【对线】写明了「不产生实质后果」，[微笑][拥抱][亲吻][示意] 也只是姿态表达。
// 这些都不改世界状态，是心理层的东西——按作者定的分层，先只留记录，等因果模型再说。
import type { Utterance } from '../core/types';

/** 白卡默认的交流动作。 */
export interface TalkAction {
  /** 动作库里的名字，带方括号，直接进记录。 */
  name: string;
  /** 一句话说清它是什么，给见证者点选时看。 */
  what: string;
  /** 要不要掷骰。白卡交流动作都不掷——对话的效果按内容判。 */
  dice: false;
  /** 会不会改世界状态。交流动作全是心理层，不改。 */
  changesWorld: false;
  /** 技能增强版的名字，没有就空着。 */
  upgradedBy: string[];
}

export const TALK_ACTIONS: TalkAction[] = [
  { name: '【攀谈】', what: '主动找人聊天', dice: false, changesWorld: false, upgradedBy: [] },
  { name: '【私聊】', what: '一对一私密交流', dice: false, changesWorld: false, upgradedBy: ['【密聊】'] },
  { name: '【喊话】', what: '远距离喊话', dice: false, changesWorld: false, upgradedBy: [] },
  { name: '【示意】', what: '手势／眼神示意', dice: false, changesWorld: false, upgradedBy: [] },
  { name: '【倾听】', what: '聆听他人或环境', dice: false, changesWorld: false, upgradedBy: ['【倾听】'] },
  { name: '【对线】', what: '非严肃的口头交锋：抬杠、拌嘴。不产生实质后果', dice: false, changesWorld: false, upgradedBy: ['【谈判】'] },
  { name: '【求助】', what: '向他人、NPC 或见证者请求帮助', dice: false, changesWorld: false, upgradedBy: [] },
  { name: '【微笑】', what: '用表情表达友善与亲和', dice: false, changesWorld: false, upgradedBy: [] },
  { name: '【拥抱】', what: '用身体接触表达亲近、安慰或安抚', dice: false, changesWorld: false, upgradedBy: ['【拥抱】'] },
  { name: '【亲吻】', what: '用亲吻表达亲密', dice: false, changesWorld: false, upgradedBy: [] },
];

export function talkActionByName(name: string): TalkAction | undefined {
  return TALK_ACTIONS.find((a) => a.name === name);
}

/**
 * 玩家原话里带这些字眼时，提示见证者可能是哪个动作。
 * 只是提示，不做决定——真正接成什么由见证者点。
 */
const HINTS: [RegExp, string][] = [
  [/吵|骂|怼|抬杠|拌嘴|评理|对线|喷/i, '【对线】'],
  [/小声|悄悄|私下|单独跟|私聊|单独说/i, '【私聊】'],
  [/喊|大声|吼|呼叫|叫住/i, '【喊话】'],
  [/求|帮帮我|拜托|求助|救命/i, '【求助】'],
  [/听|听听|有没有人/i, '【倾听】'],
  [/示意|点头|摇头|眼神|手势|打个手势/i, '【示意】'],
  [/笑/i, '【微笑】'],
  [/抱|拥抱|抱住/i, '【拥抱】'],
  [/亲|亲吻/i, '【亲吻】'],
];

/** 按原话猜一个候选动作，猜不出就返回 undefined（让人自己挑）。 */
export function guessTalkAction(text: string): TalkAction | undefined {
  for (const [re, name] of HINTS) if (re.test(text)) return talkActionByName(name);
  return undefined;
}

/**
 * 把一句话接成交流动作。
 * 交流动作不掷骰、不改世界状态，只把「见证者把它接成了什么」记下来。
 */
export function describeTalk(u: Utterance): string {
  const name = u.resolution?.label ?? '（还没接住）';
  const act = talkActionByName(name);
  if (!act) return name;
  return `${name} · ${act.what}`;
}
