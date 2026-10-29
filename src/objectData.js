// Optional enabled flag is independent of physical state and player secrecy.
export function objectEnabled(map, object) {
  return !!object && object.enabled !== false && (!object.opening || map.objects.find(o => o.id === object.opening.wallId)?.enabled !== false);
}
