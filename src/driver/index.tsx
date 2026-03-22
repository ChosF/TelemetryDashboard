/* @refresh reload */
import { Match, Switch, createSignal, onMount, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import DriverDashboard from './DriverDashboard';
import './driver.css';
import { redirectToTelemetryDashboard, verifyDriverDashboardAccess } from './driverAuth';

const root = document.getElementById('root');

if (!root) {
    throw new Error('Root element not found. Make sure there is a <div id="root"></div> in driver.html.');
}

type BootPhase = 'loading' | 'ready' | 'redirecting';

const DriverBoot: Component = () => {
    const [phase, setPhase] = createSignal<BootPhase>('loading');

    onMount(() => {
        void (async () => {
            const access = await verifyDriverDashboardAccess();
            if (access === 'allowed') {
                setPhase('ready');
                return;
            }
            setPhase('redirecting');
            if (access === 'no_session') {
                redirectToTelemetryDashboard('login');
            } else if (access === 'forbidden') {
                redirectToTelemetryDashboard('forbidden');
            } else {
                redirectToTelemetryDashboard('error');
            }
        })();
    });

    return (
        <Switch>
            <Match when={phase() === 'ready'}>
                <DriverDashboard />
            </Match>
            <Match when={phase() === 'loading' || phase() === 'redirecting'}>
                <div class="drv-boot-screen">
                    <div class="drv-boot-inner">
                        <div class="drv-boot-spinner" />
                        <p class="drv-boot-text">
                            {phase() === 'redirecting' ? 'Redirecting…' : 'Checking access…'}
                        </p>
                    </div>
                </div>
            </Match>
        </Switch>
    );
};

render(() => <DriverBoot />, root);
