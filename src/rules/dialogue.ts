// 玩家说话，以及见证者把它接成动作。
//
// 设计口径（作者定的）：
// - 不给「动作类型」下拉框，玩家想说啥说啥。用枚举限制动作等于先把想象力削掉。
// - 见证者收到原话之后自己判断：这话对应哪个动作、要不要掷骰。
//   对话的效果可以直接按对话内容判，不一定掷骰。
// - 以后接本地模型来「猜」，现在先把骨架和落点做出来：模型只是把 witness 那一步自动化。
import { uid } from '../core/util';
import type { Utterance } from '../core/types';
import { getUI, getWorld, update } from '../core/store';
import { findMap } from '../runtime/actions';

/** 一句最多这么长，防止有人贴一整篇进来。 */
export const UTTERANCE_MAX = 500;

/**
 * 谁在说、在哪张图上说。
 * 主持人端的试玩有 ui.trial，身份从那儿来；
 * 玩家自己的窗口没有 trial（那是主持人端的状态），身份由窗口自己带进来。
 */
export interface Speaker { pcId: string; tokenId: string; mapId: string; name: string }

/** 答题人是谁：优先用调用方给的，其次从主持人端的试玩状态里取。 */
function currentSpeaker(explicit?: Speaker): Speaker | string {
  if (explicit) return explicit;
  const t = getUI().trial;
  if (!t) return '只有试玩中才能说话';
  const pl = t.players[t.current];
  if (!pl) return '没有正在试玩的角色';
  return { pcId: pl.pcId, tokenId: pl.tokenId, mapId: t.mapId, name: pl.name };
}

/**
 * 玩家说一句话。返回错误字符串或 null。
 * 试玩状态下才收；工程里没在带团的时候说了也没人接。
 * 玩家窗口调用时要显式传 speaker（窗口里没有主持人端的 trial）。
 */
export function say(text: string, targetTokenId?: string | null, explicit?: Speaker): string | null {
  const who = currentSpeaker(explicit);
  if (typeof who === 'string') return who;
  const clean = text.trim();
  if (!clean) return '说点什么吧';
  if (clean.length > UTTERANCE_MAX) return `一次最多说 ${UTTERANCE_MAX} 个字`;

  const w = getWorld();
  const m = findMap(w, who.mapId);
  if (!m) return '地图不见了';
  const speaker = m.tokens.find((x) => x.id === who.tokenId);
  if (!speaker) return '找不到你的棋子';
  if (speaker.corpse) return '你已经死了，说不了话';
  if (speaker.status?.label === '昏厥') return '你昏着，说不了话';

  const target = targetTokenId ? m.tokens.find((x) => x.id === targetTokenId) : null;
  const item: Utterance = {
    id: uid(), pcId: who.pcId, pcName: who.name, text: clean,
    targetTokenId: target?.id ?? null, targetName: target?.name ?? null,
    mapId: who.mapId, at: Date.now(), session: getWorld().session,
    resolution: null,
  };
  update((d) => { (d.utterances ??= []).push(item); });
  return null;
}

/** 见证者把一句话接成一个动作。这里不强制掷骰：对话的效果可以按内容直接判。 */
export function resolveUtterance(id: string, input: {
  label: string;
  actionId?: string;
  roll?: number | null;
  outcome?: string | null;
  by?: 'witness' | 'ai';
}): string | null {
  const label = input.label.trim();
  if (!label) return '接成什么动作？至少写个名字';
  const w = getWorld();
  const u = (w.utterances ?? []).find((x) => x.id === id);
  if (!u) return '找不到这句话';
  if (u.resolution) return '这句话已经接过了';
  update((d) => {
    const du = (d.utterances ?? []).find((x) => x.id === id);
    if (!du) return;
    du.resolution = {
      label,
      actionId: input.actionId?.trim() || undefined,
      roll: input.roll ?? null,
      outcome: input.outcome?.trim() || null,
      by: input.by ?? 'witness',
      at: Date.now(),
    };
  });
  return null;
}

/** 还没被接住的话，按时间正序。见证者端的待办就是它。 */
export function pendingUtterances(): Utterance[] {
  return (getWorld().utterances ?? []).filter((u) => !u.resolution);
}

/**
 * 玩家窗口看到的话：自己说过的全部，加上别人对着自己说的（以及对着所有人说的）。
 * 别人的私聊不给他看。
 */
export function utterancesFor(pcId: string): Utterance[] {
  return (getWorld().utterances ?? []).filter((u) => {
    if (u.pcId === pcId) return true;              // 自己说的
    if (!u.targetTokenId) return true;             // 说给全场的
    return isAddressedTo(u, pcId);                 // 指名对着我说的
  });
}

function isAddressedTo(u: Utterance, pcId: string): boolean {
  const w = getWorld();
  const m = w.maps.find((x) => x.id === u.mapId);
  const t = m?.tokens.find((x) => x.id === u.targetTokenId);
  return t?.pcId === pcId;
}

/** 试玩里谁能被「说给」：同一张图上还活着、没昏过去的人。 */
export function speakTargets(): { tokenId: string; name: string }[] {
  const t = getUI().trial;
  if (!t) return [];
  const m = findMap(getWorld(), t.mapId);
  if (!m) return [];
  return m.tokens
    .filter((x) => !x.corpse && x.status?.label !== '昏厥')
    .map((x) => ({ tokenId: x.id, name: x.name }));
}
