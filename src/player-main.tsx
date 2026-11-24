// 玩家端独立入口：只挂 PlayerView，不 import App/Editor，避免把主持人端代码带进玩家包。
import { createRoot } from 'react-dom/client';
import { PlayerView } from './components/PlayerView';
import './styles.css';

createRoot(document.getElementById('root')!).render(<PlayerView />);
