import { isPlayerEntry } from './core/deployment';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import * as store from './core/store';
import * as actions from './runtime/actions';
import * as trial from './runtime/trial';
import * as perception from './scene/perception';
import * as vision from './scene/vision';
import * as sync from './runtime/sync';

// 开发模式下，把页面实际在用的模块挂出来，方便在控制台里检查和测试（打包后的版本没有）
if (import.meta.env.DEV && !isPlayerEntry()) (window as unknown as { __ts: unknown }).__ts = { store, actions, trial, perception, vision, sync };

createRoot(document.getElementById('root')!).render(<App />);
