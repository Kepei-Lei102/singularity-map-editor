import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import * as store from './store';
import * as actions from './actions';
import * as trial from './trial';
import * as perception from './perception';

// 开发模式下，把页面实际在用的模块挂出来，方便在控制台里检查和测试（打包后的版本没有）
if (import.meta.env.DEV) (window as unknown as { __ts: unknown }).__ts = { store, actions, trial, perception };

createRoot(document.getElementById('root')!).render(<App />);
