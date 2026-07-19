import { Component, onMount } from 'solid-js';
import { Router, Route } from '@solidjs/router';
import DashboardParity from '@/pages/DashboardParity';

const LegacyHistoricalRedirect: Component = () => {
    onMount(() => {
        const search = window.location.search ?? '';
        const hash = window.location.hash ?? '';
        window.location.replace(`/historical.html${search}${hash}`);
    });
    return null;
};

const LegacyDashboardRedirect: Component = () => {
    onMount(() => {
        const search = window.location.search ?? '';
        const hash = window.location.hash ?? '';
        window.location.replace(`/legacy-dashboard-do-not-use/dashboard.html${search}${hash}`);
    });
    return null;
};

const DashboardAliasRedirect: Component = () => {
    onMount(() => {
        const search = window.location.search ?? '';
        const hash = window.location.hash ?? '';
        window.location.replace(`/dashboard${search}${hash}`);
    });
    return null;
};

const App: Component = () => {
    return (
        <Router>
            <Route path="/dashboard" component={DashboardParity} />
            <Route path="/dashboard-solid" component={DashboardAliasRedirect} />
            <Route path="/dashboard-legacy" component={LegacyDashboardRedirect} />
            <Route path="/dashboard/sessions" component={LegacyHistoricalRedirect} />
            <Route path="/historical/:sessionId" component={LegacyHistoricalRedirect} />
            <Route path="/historical/custom" component={LegacyHistoricalRedirect} />
            <Route path="*" component={DashboardParity} />
        </Router>
    );
};

export default App;
