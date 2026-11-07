// A deployed player entry stays a player even if its query string is changed.
const env = import.meta.env;
export const appRole = env?.VITE_APP_ROLE ?? '';
/** 显式要玩家视角（?view=player）。 */
const wantsPlayer = () => new URLSearchParams(location.search).get('view') === 'player';
/**
 * 玩家窗口。分开部署时玩家端整个就是 player 角色，改 query 也不会变回主持人；
 * 但开发时只起一个 dev server（或单独文件版），主页面和玩家窗口是同一个 URL，
 * 这时只能靠 ?view=player 区分——否则同源打开会被当成主持人，窗口卡住。
 */
export const isPlayerEntry = () => appRole === 'player' || wantsPlayer();
const origin = (value: string | undefined) => value ? new URL(value).origin : location.origin;
/** 打包/部署时的固定地址；开发时可能没配，这时就跟着当前页面走。 */
export const configuredHostOrigin = () => env?.VITE_HOST_ORIGIN ? origin(env.VITE_HOST_ORIGIN) : null;
export const configuredPlayerOrigin = () => env?.VITE_PLAYER_ORIGIN ? origin(env.VITE_PLAYER_ORIGIN) : null;
export const hostOrigin = () => origin(env?.VITE_HOST_ORIGIN);
export const playerOrigin = () => origin(env?.VITE_PLAYER_ORIGIN);
/**
 * 开发时只有一个 dev server（比如只起了 dev:host 的 5178），却按配置去开 5179，
 * 就会跳到没人监听的地址、窗口卡死。没配置玩家端口时，同源打开页面就够了。
 */
export const playerWindowOrigin = () => configuredPlayerOrigin() ?? location.origin;
export const playerWindowBase = (): string => { const o = playerWindowOrigin(); return o === location.origin ? '' : `${o}/`; };
/** 玩家窗口该往哪边回话：部署时钉住的地址；开发时玩家窗口和主持人是同一个源，回当前来源。 */
export const hostOriginForPlayer = () => configuredHostOrigin() ?? location.origin;
export const messageTarget = (value: string) => value === 'null' ? '*' : value;
