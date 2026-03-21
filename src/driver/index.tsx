/* @refresh reload */
import { render } from 'solid-js/web';
import DriverDashboard from './DriverDashboard';
import './driver.css';

const root = document.getElementById('root');

if (!root) {
    throw new Error('Root element not found.');
}

render(() => <DriverDashboard />, root);
