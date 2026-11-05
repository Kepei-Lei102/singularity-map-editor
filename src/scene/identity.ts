import type { MapObject, SeenObject } from '../core/types';

export interface IdentityKnowledge { party?: boolean; recipients?: string[] }
export const UNKNOWN_OBJECT = '未辨识物件';
export const identityCheck = (check: string) => /观察|见证者.*揭幕/.test(check);

/** Identity is explicit knowledge, independent of shared sight or automatic proximity clues. */
export function identityKnowledge(o: MapObject): IdentityKnowledge {
  const recipients = new Set(o.identity?.recipients ?? []);
  let party = !!o.identity?.party;
  for (const s of o.secrets) {
    if (s.kind !== 'roll' || !identityCheck(s.check)) continue;
    const success = (tier: string) => tier === 'success' || tier === 'crit';
    if (s.revealed && success(s.revealed.tier)) {
      if (s.revealed.scope === 'party') party = true;
      else for (const id of s.revealed.recipients ?? []) recipients.add(id);
    }
    for (const [id, r] of Object.entries(s.discoveries ?? {})) if (success(r.tier)) recipients.add(id);
  }
  return { party, recipients: [...recipients] };
}
export function identityKnown(o: MapObject | SeenObject, pcId?: string): boolean {
  const k = 'secrets' in o ? identityKnowledge(o) : o.identity;
  return !!(k?.party || pcId && k?.recipients?.includes(pcId));
}
export function playerObject(o: MapObject, pcId?: string): MapObject {
  return identityKnown(o, pcId) ? o : { ...o, name: UNKNOWN_OBJECT, icon: '', states: [''], state: 0 };
}
export function playerSeen(r: SeenObject, pcId?: string, live?: MapObject): SeenObject {
  const { identity: _identity, ...out } = r;
  return identityKnown(live ?? r, pcId) ? out : { ...out, name: UNKNOWN_OBJECT, icon: '', stateLabel: null };
}
