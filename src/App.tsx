import { Component, onMount } from 'solid-js';
import { Router, Route } from '@solidjs/router';
import DashboardSolid from '@/pages/DashboardSolid';

const LegacyHistoricalRedirect: Component = () => {
    onMount(() => {
        const search = window.location.search ?? '';
        const hash = window.location.hash ?? '';
        window.location.replace(`/historical.html${search}${hash}`);
    });
    return null;
};

const App: Component = () => {
    return (
        <Router>
            <Route path="/dashboard" component={DashboardSolid} />
            <Route path="/dashboard/sessions" component={LegacyHistoricalRedirect} />
            <Route path="/historical/:sessionId" component={LegacyHistoricalRedirect} />
            <Route path="/historical/custom" component={LegacyHistoricalRedirect} />
            <Route path="*" component={DashboardSolid} />
        </Router>
    );
};

export default App;
