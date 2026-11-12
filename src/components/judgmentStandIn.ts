import type { DiceTrayRecord } from './DiceTray';

/**
 * 见证者代掷的“下一颗”怎么走。
 * 只算状态转换，不碰 store / 网络，测试可以把整套序列直接跑一遍。
 */
export type StandInMode =
  | { kind: 'attrs'; attrs: string[] }
  | { kind: 'two'; advantage: boolean };

export interface StandInStep {
  rolls: DiceTrayRecord[];
  done: boolean;
  message: string | null;
  /** 交给结算的那一颗：多属性取第一颗，优/劣势取采信的那颗。 */
  chosen?: DiceTrayRecord;
  /** 结算的 value：多属性用第一颗，优/劣势用采信值。 */
  value?: number;
  /** 优/劣势要把两颗一起交给引擎；多属性是全部属性骰。 */
  values?: number[];
}

const fmt = (v: number) => (v === 100 ? '000' : String(v));

export function applyStandInRoll(prev: DiceTrayRecord[], roll: DiceTrayRecord, mode: StandInMode): StandInStep {
  const rolls = [...prev, roll];

  if (mode.kind === 'attrs') {
    if (rolls.length < mode.attrs.length) {
      const next = mode.attrs[rolls.length];
      return {
        rolls, done: false,
        message: `已掷 ${mode.attrs[rolls.length - 1]}：D${roll.sides}=${fmt(roll.value)}；再掷 ${next}`,
      };
    }
    return {
      rolls, done: true, message: null,
      chosen: rolls[0], value: rolls[0].value, values: rolls.map((x) => x.value),
    };
  }

  if (rolls.length < 2) {
    return {
      rolls, done: false,
      message: `已掷 D${roll.sides}=${fmt(roll.value)}；再掷一颗，取${mode.advantage ? '高' : '低'}`,
    };
  }
  const taken = mode.advantage
    ? Math.max(...rolls.map((x) => x.value))
    : Math.min(...rolls.map((x) => x.value));
  const chosen = rolls.find((x) => x.value === taken)!;
  return {
    rolls, done: true, message: null,
    chosen, value: taken, values: rolls.map((x) => x.value),
  };
}

/**
 * 结算失败时把这一组代掷骰清掉，下一次从第一颗重新来；
 * 成功时不动（pending 马上会被关掉）。
 */
export function afterStandInSettle(error: string | null, rolls: DiceTrayRecord[]): { rolls: DiceTrayRecord[]; message: string | null } {
  return error ? { rolls: [], message: error } : { rolls, message: null };
}
