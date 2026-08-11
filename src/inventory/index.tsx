import { render } from 'solid-js/web';
import InventoryPrototype from './InventoryPrototype';
import { authStore } from '@/stores/auth';
import { getClient, initConvex } from '@/lib/convex';
import './inventory.css';

const root = document.getElementById('inventory-root');

if (!root) throw new Error('Inventory root element not found');

async function boot(): Promise<void> {
  const config = (window as Window & { CONFIG?: { CONVEX_URL?: string } }).CONFIG;
  const convexUrl = config?.CONVEX_URL?.trim();
  if (!convexUrl) throw new Error('Inventory configuration is unavailable');
  if (!await initConvex(convexUrl)) throw new Error('Could not connect to inventory data');
  await authStore.initAuth(getClient());
  render(() => <InventoryPrototype />, root!);
}

root.innerHTML = '<div class="iv-boot"><span>ECOVOLT / INVENTORY</span><strong>Connecting to the tool register…</strong></div>';

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Inventory failed to start';
  root.innerHTML = `<div class="iv-boot iv-boot-error"><span>INVENTORY OFFLINE</span><strong>${message}</strong><a href="/">Return home</a></div>`;
});
