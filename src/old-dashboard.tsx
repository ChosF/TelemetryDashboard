/* @refresh reload */
import { render } from 'solid-js/web';
import DashboardOld from '@/pages/DashboardOld';
import '@/styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root element not found');

render(() => <DashboardOld />, root);
