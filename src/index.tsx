/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App';

// Import existing CSS variables and design system
import './styles/index.css';

const root = document.getElementById('root');

if (!root) {
    throw new Error('Root element not found. Make sure there is a <div id="root"></div> in your HTML.');
}

render(() => <App />, root);
