// A deployed player entry stays a player even if its query string is changed.
const env = import.meta.env;
export const appRole = env?.VITE_APP_ROLE ?? '';
export const isPlayerEntry = () => appRole === 'player' || appRole !== 'host' && new URLSearchParams(location.search).get('view') === 'player';
const origin = (value: string | undefined) => value ? new URL(value).origin : location.origin;
export const hostOrigin = () => origin(env?.VITE_HOST_ORIGIN);
export const playerOrigin = () => origin(env?.VITE_PLAYER_ORIGIN);
export const messageTarget = (value: string) => value === 'null' ? '*' : value;
