import { createRoot } from 'react-dom/client';
import '../shared/styles/pages.css';
import './style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
