import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from 'solid-js';
import QRCode from 'qrcode';
import { authStore } from '@/stores/auth';
import {
  cancelInventoryLoan,
  createInventoryItem,
  createInventoryLoan,
  decideInventoryLoan,
  getItemByAssetCode,
  markInventoryLoanReturned,
  recordInventoryMovement,
  watchInventoryItems,
  watchInventoryLoans,
  type InventoryItem,
  type InventoryItemStatus,
  type InventoryLoan,
  type InventoryLoanStatus,
} from './inventoryApi';

type Section = 'overview' | 'items' | 'loans';
type Modal = 'auth' | 'account' | 'add' | 'scan' | 'item' | 'movement' | 'loan' | 'qr' | null;
type IconName = 'home' | 'items' | 'loan' | 'scan' | 'search' | 'plus' | 'user' | 'close' | 'arrow' | 'pin' | 'clock' | 'check' | 'qr' | 'shield';

const statusLabels: Record<InventoryItemStatus, string> = {
  available: 'Available',
  on_loan: 'On loan',
  reserved: 'Reserved',
  maintenance: 'Maintenance',
  retired: 'Retired',
};

const loanStatusLabels: Record<InventoryLoanStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
  returned: 'Returned',
};

const Icon: Component<{ name: IconName }> = (props) => (
  <svg class="iv-icon" viewBox="0 0 24 24" aria-hidden="true">
    <Switch>
      <Match when={props.name === 'home'}><path d="m3 11 9-8 9 8" /><path d="M5 10v11h14V10M9 21v-7h6v7" /></Match>
      <Match when={props.name === 'items'}><path d="M4 7h16v13H4zM7 7V4h10v3M8 12h8M8 16h5" /></Match>
      <Match when={props.name === 'loan'}><path d="M6 3h9l3 3v15H6zM14 3v4h4M9 12h6M9 16h4" /></Match>
      <Match when={props.name === 'scan'}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10" /></Match>
      <Match when={props.name === 'search'}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></Match>
      <Match when={props.name === 'plus'}><path d="M12 5v14M5 12h14" /></Match>
      <Match when={props.name === 'user'}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></Match>
      <Match when={props.name === 'close'}><path d="m5 5 14 14M19 5 5 19" /></Match>
      <Match when={props.name === 'arrow'}><path d="M5 12h14M14 7l5 5-5 5" /></Match>
      <Match when={props.name === 'pin'}><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></Match>
      <Match when={props.name === 'clock'}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Match>
      <Match when={props.name === 'check'}><path d="m5 12 4 4L19 6" /></Match>
      <Match when={props.name === 'qr'}><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM15 15h2v2h-2zM18 14h2v3h-2zM14 19h3M19 19h1" /></Match>
      <Match when={props.name === 'shield'}><path d="M12 3 5 6v5c0 4.6 2.7 8.3 7 10 4.3-1.7 7-5.4 7-10V6z" /><path d="m9 12 2 2 4-5" /></Match>
    </Switch>
  </svg>
);

function compactQrPayload(assetCode: string): string {
  return `EV:${assetCode}`;
}

function extractAssetCode(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (value.startsWith('EV:')) return value.slice(3);
  const urlMatch = value.match(/[?&]ASSET=([A-Z0-9-]+)/);
  return (urlMatch?.[1] ?? value).replace(/\s+/g, '-');
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function localDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function userInitials(): string {
  const value = authStore.user()?.name || authStore.user()?.email || 'User';
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

const Brand: Component = () => (
  <a class="iv-brand" href="/" aria-label="EcoVolt home">
    <img src="/images/logo.png" alt="" width="756" height="706" />
    <span><strong>EcoVolt</strong><small>Inventory</small></span>
  </a>
);

const Status: Component<{ value: InventoryItemStatus | InventoryLoanStatus }> = (props) => (
  <span class="iv-status" data-status={props.value}><i />{statusLabels[props.value as InventoryItemStatus] ?? loanStatusLabels[props.value as InventoryLoanStatus]}</span>
);

const QrMark: Component<{ assetCode: string; printable?: boolean }> = (props) => {
  const [src, setSrc] = createSignal('');
  createEffect(() => {
    const payload = compactQrPayload(props.assetCode);
    void QRCode.toDataURL(payload, {
      version: 1,
      errorCorrectionLevel: 'H',
      margin: 1,
      width: props.printable ? 504 : 168,
      color: { dark: '#000000', light: '#ffffff' },
    }).then(setSrc);
  });
  return <div class="iv-real-qr" classList={{ printable: props.printable }}><Show when={src()}><img src={src()} alt={`QR label for ${props.assetCode}`} /></Show></div>;
};

const InventoryPrototype: Component = () => {
  const [section, setSection] = createSignal<Section>('overview');
  const [modal, setModal] = createSignal<Modal>(null);
  const [items, setItems] = createSignal<InventoryItem[]>([]);
  const [loans, setLoans] = createSignal<InventoryLoan[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [selectedItem, setSelectedItem] = createSignal<InventoryItem | null>(null);
  const [toast, setToast] = createSignal('');

  const isApproved = createMemo(() => authStore.isAuthenticated() && authStore.user()?.approval_status === 'approved' && authStore.userRole() !== 'guest');
  const canManage = createMemo(() => authStore.userRole() === 'internal' || authStore.userRole() === 'admin');
  const isAdmin = createMemo(() => authStore.userRole() === 'admin');
  const pendingLoans = createMemo(() => loans().filter((loan) => loan.status === 'pending').length);
  const availableItems = createMemo(() => items().filter((item) => item.status === 'available').length);
  const filteredItems = createMemo(() => {
    const query = search().trim().toLowerCase();
    if (!query) return items();
    return items().filter((item) => `${item.name} ${item.assetCode} ${item.category} ${item.currentLocation}`.toLowerCase().includes(query));
  });

  createEffect(() => {
    if (!isApproved()) {
      setItems([]);
      setLoans([]);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    const stopItems = watchInventoryItems((value) => {
      setItems(value);
      setLoaded(true);
    });
    const stopLoans = watchInventoryLoans(setLoans);
    onCleanup(() => {
      stopItems();
      stopLoans();
    });
  });

  createEffect(() => {
    const selected = selectedItem();
    if (!selected) return;
    const updated = items().find((item) => item._id === selected._id);
    if (updated && updated.updatedAt !== selected.updatedAt) setSelectedItem(updated);
  });

  let deepLinkHandled = false;
  createEffect(() => {
    if (deepLinkHandled || !isApproved() || !loaded()) return;
    const asset = new URLSearchParams(window.location.search).get('asset');
    if (!asset) return;
    deepLinkHandled = true;
    void openAsset(asset);
  });

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const openAsset = async (raw: string) => {
    const code = extractAssetCode(raw);
    const local = items().find((item) => item.assetCode === code);
    const item = local ?? await getItemByAssetCode(code);
    if (!item) throw new Error(`No item matches ${code}`);
    setSelectedItem(item);
    setModal(canManage() ? 'movement' : 'item');
  };

  const chooseItem = (item: InventoryItem) => {
    setSelectedItem(item);
    setModal('item');
  };

  const openLoan = (item?: InventoryItem) => {
    if (!isApproved()) {
      setModal('auth');
      return;
    }
    if (item) setSelectedItem(item);
    setModal('loan');
  };

  return (
    <div class="inventory-app">
      <header class="iv-header">
        <Brand />
        <nav class="iv-desktop-nav" aria-label="Inventory sections">
          <SectionButton value="overview" current={section()} onSelect={setSection} label="Overview" />
          <SectionButton value="items" current={section()} onSelect={setSection} label="Items" count={items().length} />
          <SectionButton value="loans" current={section()} onSelect={setSection} label="Loans" count={pendingLoans()} />
        </nav>
        <div class="iv-header-actions">
          <Show when={isApproved()}><button class="iv-icon-button" aria-label="Search items" onClick={() => setSection('items')}><Icon name="search" /></button></Show>
          <button class="iv-account-button" aria-label="Open account" onClick={() => setModal(authStore.isAuthenticated() ? 'account' : 'auth')}>
            <Show when={authStore.isAuthenticated()} fallback={<Icon name="user" />}><span>{userInitials()}</span></Show>
          </button>
        </div>
      </header>

      <main>
        <section class="iv-hero">
          <span class="iv-eyebrow">EcoVolt equipment</span>
          <h1>Tools, accounted for.</h1>
          <p>Scan a label, confirm the handoff, and keep the workshop moving.</p>
          <div class="iv-hero-actions">
            <button class="iv-primary" onClick={() => isApproved() ? setModal('scan') : setModal('auth')}><Icon name="scan" />Scan item</button>
            <button class="iv-secondary" onClick={() => openLoan()}>Request a loan</button>
          </div>
        </section>

        <Show when={isApproved()} fallback={<AccessState onSignIn={() => setModal('auth')} />}>
          <Switch>
            <Match when={section() === 'overview'}>
              <section class="iv-overview">
                <div class="iv-stat-strip">
                  <article><span>Total items</span><strong>{items().length.toString().padStart(2, '0')}</strong></article>
                  <article><span>Available</span><strong>{availableItems().toString().padStart(2, '0')}</strong></article>
                  <article><span>On loan</span><strong>{items().filter((item) => item.status === 'on_loan').length.toString().padStart(2, '0')}</strong></article>
                  <article><span>Pending loans</span><strong>{pendingLoans().toString().padStart(2, '0')}</strong></article>
                </div>
                <section class="iv-section-block">
                  <SectionHeading eyebrow="Live register" title="Recently updated" action={isAdmin() ? 'Add first item' : undefined} onAction={() => setModal('add')} />
                  <Show when={loaded() && items().length > 0} fallback={<EmptyItems admin={isAdmin()} onAdd={() => setModal('add')} />}>
                    <div class="iv-item-grid"><For each={items().slice(0, 6)}>{(item) => <ItemCard item={item} onOpen={() => chooseItem(item)} />}</For></div>
                  </Show>
                </section>
              </section>
            </Match>

            <Match when={section() === 'items'}>
              <section class="iv-page">
                <SectionHeading eyebrow="Tool register" title="Items" action={isAdmin() ? 'Add item' : undefined} onAction={() => setModal('add')} />
                <div class="iv-search"><Icon name="search" /><input type="search" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Search name, code, category, or place" /></div>
                <Show when={loaded() && filteredItems().length > 0} fallback={<EmptyItems admin={isAdmin()} onAdd={() => setModal('add')} filtered={items().length > 0} />}>
                  <div class="iv-item-grid"><For each={filteredItems()}>{(item) => <ItemCard item={item} onOpen={() => chooseItem(item)} />}</For></div>
                </Show>
              </section>
            </Match>

            <Match when={section() === 'loans'}>
              <section class="iv-page">
                <SectionHeading eyebrow={canManage() ? 'Approval workspace' : 'Your requests'} title="Loans" action={items().length > 0 ? 'New loan' : undefined} onAction={() => openLoan()} />
                <Show when={loans().length > 0} fallback={<EmptyLoans hasItems={items().length > 0} onCreate={() => openLoan()} />}>
                  <div class="iv-loan-grid"><For each={loans()}>{(loan) => <LoanCard loan={loan} canManage={canManage()} currentUserId={authStore.user()?.userId ?? ''} onNotify={notify} />}</For></div>
                </Show>
              </section>
            </Match>
          </Switch>
        </Show>
      </main>

      <nav class="iv-mobile-nav" aria-label="Inventory navigation">
        <SectionButton value="overview" current={section()} onSelect={setSection} label="Overview" icon="home" />
        <SectionButton value="items" current={section()} onSelect={setSection} label="Items" icon="items" />
        <button class="iv-mobile-scan" onClick={() => isApproved() ? setModal('scan') : setModal('auth')}><Icon name="scan" /><span>Scan</span></button>
        <SectionButton value="loans" current={section()} onSelect={setSection} label="Loans" icon="loan" />
        <button onClick={() => setModal(authStore.isAuthenticated() ? 'account' : 'auth')}><Icon name="user" /><span>Account</span></button>
      </nav>

      <Show when={modal() === 'auth'}><AuthModal onClose={() => setModal(null)} onReady={() => { setModal(null); notify('Signed in to inventory'); }} /></Show>
      <Show when={modal() === 'account'}><AccountModal onClose={() => setModal(null)} onAdd={() => setModal('add')} /></Show>
      <Show when={modal() === 'add'}><AddItemModal onClose={() => setModal(null)} onCreated={async (code) => { const item = await getItemByAssetCode(code); setSelectedItem(item); setModal('qr'); notify(`${code} added to inventory`); }} /></Show>
      <Show when={modal() === 'scan'}><ScannerModal onClose={() => setModal(null)} onCode={openAsset} /></Show>
      <Show when={modal() === 'item' && selectedItem()}>{(item) => <ItemModal item={item()} canManage={canManage()} onClose={() => setModal(null)} onMove={() => setModal('movement')} onLoan={() => openLoan(item())} onQr={() => setModal('qr')} />}</Show>
      <Show when={modal() === 'movement' && selectedItem()}>{(item) => <MovementModal item={item()} onClose={() => setModal(null)} onSaved={() => { setModal(null); notify(`${item().assetCode} movement recorded`); }} />}</Show>
      <Show when={modal() === 'loan'}><LoanModal items={items()} selected={selectedItem()} onClose={() => setModal(null)} onSaved={() => { setModal(null); setSection('loans'); notify('Loan sent for approval'); }} /></Show>
      <Show when={modal() === 'qr' && selectedItem()}>{(item) => <QrModal item={item()} onClose={() => setModal(null)} />}</Show>
      <Show when={toast()}><div class="iv-toast" role="status"><Icon name="check" />{toast()}</div></Show>
    </div>
  );
};

const SectionButton: Component<{ value: Section; current: Section; onSelect: (value: Section) => void; label: string; count?: number; icon?: IconName }> = (props) => (
  <button classList={{ active: props.value === props.current }} onClick={() => props.onSelect(props.value)}>
    <Show when={props.icon}><Icon name={props.icon!} /></Show><span>{props.label}</span><Show when={props.count !== undefined}><b>{props.count!.toString().padStart(2, '0')}</b></Show>
  </button>
);

const SectionHeading: Component<{ eyebrow: string; title: string; action?: string; onAction: () => void }> = (props) => (
  <header class="iv-section-heading"><div><span class="iv-eyebrow">{props.eyebrow}</span><h2>{props.title}</h2></div><Show when={props.action}><button class="iv-secondary" onClick={props.onAction}><Icon name="plus" />{props.action}</button></Show></header>
);

const AccessState: Component<{ onSignIn: () => void }> = (props) => (
  <section class="iv-access-state">
    <div><Icon name="shield" /></div>
    <span class="iv-eyebrow">Shared EcoVolt account</span>
    <h2>{authStore.needsApproval() ? 'Access request pending.' : 'Sign in to open inventory.'}</h2>
    <p>{authStore.needsApproval() ? 'An administrator needs to approve your account before inventory data becomes available.' : 'The inventory uses the same approved accounts as the telemetry dashboard.'}</p>
    <Show when={!authStore.needsApproval()}><button class="iv-primary" onClick={props.onSignIn}>Sign in</button></Show>
  </section>
);

const EmptyItems: Component<{ admin: boolean; onAdd: () => void; filtered?: boolean }> = (props) => (
  <div class="iv-empty-state"><div><Icon name="items" /></div><span class="iv-eyebrow">{props.filtered ? 'No match' : 'Empty register'}</span><h3>{props.filtered ? 'Try another search.' : 'No items have been added yet.'}</h3><p>{props.filtered ? 'Search by asset code, item name, category, or current place.' : props.admin ? 'Add the first item to generate its compact printable QR label.' : 'An administrator can add the first inventory item.'}</p><Show when={props.admin && !props.filtered}><button class="iv-primary" onClick={props.onAdd}><Icon name="plus" />Add first item</button></Show></div>
);

const EmptyLoans: Component<{ hasItems: boolean; onCreate: () => void }> = (props) => (
  <div class="iv-empty-state"><div><Icon name="loan" /></div><span class="iv-eyebrow">Loan register</span><h3>No loan activity yet.</h3><p>{props.hasItems ? 'Request an item and its approval trail will appear here.' : 'Loans will become available after an administrator adds an item.'}</p><Show when={props.hasItems}><button class="iv-primary" onClick={props.onCreate}>Request a loan</button></Show></div>
);

const ItemCard: Component<{ item: InventoryItem; onOpen: () => void }> = (props) => (
  <article class="iv-item-card">
    <header><span>{props.item.category} / {props.item.assetCode}</span><Status value={props.item.status} /></header>
    <div class="iv-item-card-main"><div><h3>{props.item.name}</h3><p>{props.item.stewardTeam ? `Stewarded by ${props.item.stewardTeam}` : 'EcoVolt shared equipment'}</p></div><QrMark assetCode={props.item.assetCode} /></div>
    <dl><div><dt><Icon name="pin" />Current place</dt><dd>{props.item.currentLocation}</dd></div><div><dt><Icon name="user" />Last updated</dt><dd>{props.item.updatedByName} · {formatDate(props.item.updatedAt)}</dd></div></dl>
    <button onClick={props.onOpen}>Open item <Icon name="arrow" /></button>
  </article>
);

const LoanCard: Component<{ loan: InventoryLoan; canManage: boolean; currentUserId: string; onNotify: (message: string) => void }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const act = async (action: () => Promise<void>, message: string) => {
    setBusy(true);
    try { await action(); props.onNotify(message); } finally { setBusy(false); }
  };
  return <article class="iv-loan-card"><header><span>{props.loan.assetCode}</span><Status value={props.loan.status} /></header><h3>{props.loan.itemName}</h3><p>{props.loan.purpose}</p><dl><div><dt>Requested by</dt><dd>{props.loan.requesterName} · {props.loan.requesterTeam}</dd></div><div><dt>Loan window</dt><dd>{formatDate(props.loan.startAt)} — {formatDate(props.loan.dueAt)}</dd></div></dl><footer><Show when={props.canManage && props.loan.status === 'pending'}><button disabled={busy()} class="approve" onClick={() => void act(() => decideInventoryLoan(props.loan._id, 'approved'), 'Loan approved')}>Approve</button><button disabled={busy()} onClick={() => void act(() => decideInventoryLoan(props.loan._id, 'denied'), 'Loan denied')}>Deny</button></Show><Show when={props.canManage && props.loan.status === 'approved'}><button disabled={busy()} class="approve" onClick={() => void act(() => markInventoryLoanReturned(props.loan._id), 'Item marked returned')}>Mark returned</button></Show><Show when={props.loan.requesterUserId === props.currentUserId && props.loan.status === 'pending'}><button disabled={busy()} onClick={() => void act(() => cancelInventoryLoan(props.loan._id), 'Loan cancelled')}>Cancel request</button></Show></footer></article>;
};

const ModalShell: Component<{ label: string; eyebrow: string; title: string; description?: string; onClose: () => void; children: JSX.Element }> = (props) => (
  <div class="iv-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><section class="iv-modal" role="dialog" aria-modal="true" aria-label={props.label}><header><div><span class="iv-eyebrow">{props.eyebrow}</span><h2>{props.title}</h2><Show when={props.description}><p>{props.description}</p></Show></div><button aria-label="Close" onClick={props.onClose}><Icon name="close" /></button></header>{props.children}</section></div>
);

const AuthModal: Component<{ onClose: () => void; onReady: () => void }> = (props) => {
  const [mode, setMode] = createSignal<'signin' | 'signup'>('signin');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [name, setName] = createSignal('');
  const [role, setRole] = createSignal<'external' | 'internal'>('external');
  const [error, setError] = createSignal('');
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setError('');
    const result = mode() === 'signin' ? await authStore.signIn(email(), password(), true) : await authStore.signUp(email(), password(), role(), name());
    if (!result.success) { setError(result.error ?? 'Authentication failed'); return; }
    props.onReady();
  };
  return <ModalShell label="Inventory account" eyebrow="EcoVolt account" title={mode() === 'signin' ? 'Sign in' : 'Create account'} description="Your dashboard and inventory use the same secure account." onClose={props.onClose}><form class="iv-form" onSubmit={(event) => void submit(event)}><Show when={mode() === 'signup'}><label><span>Name</span><input required value={name()} onInput={(event) => setName(event.currentTarget.value)} autocomplete="name" /></label></Show><label><span>Email</span><input required type="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} autocomplete="email" /></label><label><span>Password</span><input required minlength="8" type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autocomplete={mode() === 'signin' ? 'current-password' : 'new-password'} /></label><Show when={mode() === 'signup'}><label><span>Requested access</span><select value={role()} onChange={(event) => setRole(event.currentTarget.value as 'external' | 'internal')}><option value="external">External team · request loans</option><option value="internal">EcoVolt internal · approval required</option></select></label></Show><Show when={error()}><div class="iv-form-error" role="alert">{error()}</div></Show><button class="iv-primary" type="submit" disabled={authStore.isLoading()}>{authStore.isLoading() ? 'Please wait…' : mode() === 'signin' ? 'Sign in' : 'Create account'}</button><button class="iv-form-switch" type="button" onClick={() => setMode(mode() === 'signin' ? 'signup' : 'signin')}>{mode() === 'signin' ? 'Need an account? Create one' : 'Already registered? Sign in'}</button></form></ModalShell>;
};

const AccountModal: Component<{ onClose: () => void; onAdd: () => void }> = (props) => (
  <ModalShell label="Inventory account" eyebrow="Current account" title={authStore.user()?.name ?? authStore.user()?.email ?? 'Account'} description={`${authStore.userRole()} · ${authStore.user()?.approval_status}`} onClose={props.onClose}><div class="iv-account-sheet"><div class="iv-account-identity"><span>{userInitials()}</span><div><strong>{authStore.user()?.email}</strong><small>Shared with the telemetry dashboard</small></div></div><Show when={authStore.isAdmin()}><button class="iv-secondary" onClick={props.onAdd}><Icon name="plus" />Add inventory item</button></Show><a href="/dashboard">Open telemetry dashboard <Icon name="arrow" /></a><button class="iv-danger" onClick={() => void authStore.signOut().then(props.onClose)}>Sign out</button></div></ModalShell>
);

const AddItemModal: Component<{ onClose: () => void; onCreated: (code: string) => void | Promise<void> }> = (props) => {
  const [code, setCode] = createSignal(''); const [name, setName] = createSignal(''); const [category, setCategory] = createSignal(''); const [location, setLocation] = createSignal(''); const [team, setTeam] = createSignal(''); const [description, setDescription] = createSignal(''); const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const submit = async (event: SubmitEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await createInventoryItem({ assetCode: code(), name: name(), category: category(), homeLocation: location(), stewardTeam: team() || undefined, description: description() || undefined }); await props.onCreated(result.assetCode); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add item'); } finally { setBusy(false); } };
  return <ModalShell label="Add inventory item" eyebrow="Admin / new item" title="Add an item" description="The short asset code becomes a Version 1 high-reliability QR label." onClose={props.onClose}><form class="iv-form" onSubmit={(event) => void submit(event)}><div class="iv-field-grid"><label><span>Asset code · max 7</span><input required maxlength="7" placeholder="TQ-017" value={code()} onInput={(event) => setCode(event.currentTarget.value.toUpperCase())} /></label><label><span>Category</span><input required placeholder="Mechanical" value={category()} onInput={(event) => setCategory(event.currentTarget.value)} /></label></div><label><span>Item name</span><input required placeholder="Digital torque wrench" value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label><label><span>Home location</span><input required placeholder="Workshop · Bay 02" value={location()} onInput={(event) => setLocation(event.currentTarget.value)} /></label><label><span>Steward team</span><input placeholder="Vehicle dynamics" value={team()} onInput={(event) => setTeam(event.currentTarget.value)} /></label><label><span>Description</span><textarea rows="3" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label><Show when={error()}><div class="iv-form-error">{error()}</div></Show><button class="iv-primary" disabled={busy()}>{busy() ? 'Adding…' : 'Add item and create QR'}</button></form></ModalShell>;
};

interface BarcodeDetectorLike { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>; }
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

const ScannerModal: Component<{ onClose: () => void; onCode: (value: string) => Promise<void> }> = (props) => {
  const [manual, setManual] = createSignal(''); const [error, setError] = createSignal(''); const [camera, setCamera] = createSignal<'idle' | 'running' | 'unavailable'>('idle'); let video!: HTMLVideoElement; let stream: MediaStream | null = null; let frame = 0;
  const stop = () => { window.cancelAnimationFrame(frame); stream?.getTracks().forEach((track) => track.stop()); stream = null; };
  onCleanup(stop);
  const resolve = async (value: string) => { setError(''); try { stop(); await props.onCode(value); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Item not found'); } };
  const start = async () => { const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector; if (!Detector || !navigator.mediaDevices?.getUserMedia) { setCamera('unavailable'); return; } try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); video.srcObject = stream; await video.play(); setCamera('running'); const detector = new Detector({ formats: ['qr_code'] }); const scan = async () => { if (!stream) return; const results = await detector.detect(video); if (results[0]?.rawValue) { await resolve(results[0].rawValue); return; } frame = window.requestAnimationFrame(() => void scan()); }; void scan(); } catch { setCamera('unavailable'); } };
  return <ModalShell label="Scan item QR" eyebrow="Compact QR scanner" title="Scan item" description="Designed for small, high-contrast EcoVolt labels." onClose={() => { stop(); props.onClose(); }}><div class="iv-scanner"><div class="iv-camera"><video ref={video} muted playsinline /><div class="iv-scan-frame"><i /><i /><i /><i /><span /></div><Show when={camera() !== 'running'}><Icon name="scan" /></Show></div><Show when={camera() === 'idle'}><button class="iv-primary" onClick={() => void start()}>Start camera</button></Show><Show when={camera() === 'unavailable'}><div class="iv-form-note">Camera QR detection is unavailable here. Enter the printed asset code below.</div></Show><form onSubmit={(event) => { event.preventDefault(); void resolve(manual()); }}><label><span>Asset code or QR value</span><input required placeholder="EV:TQ-017" value={manual()} onInput={(event) => setManual(event.currentTarget.value)} /></label><button class="iv-secondary">Open item</button></form><Show when={error()}><div class="iv-form-error">{error()}</div></Show></div></ModalShell>;
};

const ItemModal: Component<{ item: InventoryItem; canManage: boolean; onClose: () => void; onMove: () => void; onLoan: () => void; onQr: () => void }> = (props) => (
  <ModalShell label={`Item ${props.item.assetCode}`} eyebrow={`${props.item.category} / ${props.item.assetCode}`} title={props.item.name} description={props.item.description} onClose={props.onClose}><div class="iv-item-detail"><div class="iv-item-detail-top"><QrMark assetCode={props.item.assetCode} /><Status value={props.item.status} /></div><dl><div><dt>Current place</dt><dd>{props.item.currentLocation}</dd></div><div><dt>Home</dt><dd>{props.item.homeLocation}</dd></div><div><dt>Updated by</dt><dd>{props.item.updatedByName}</dd></div><div><dt>Updated</dt><dd>{formatDate(props.item.updatedAt)}</dd></div></dl><div class="iv-detail-actions"><Show when={props.canManage}><button class="iv-primary" onClick={props.onMove}><Icon name="scan" />Record movement</button></Show><button class="iv-secondary" onClick={props.onLoan}>Request loan</button><button class="iv-secondary" onClick={props.onQr}><Icon name="qr" />QR label</button></div></div></ModalShell>
);

const MovementModal: Component<{ item: InventoryItem; onClose: () => void; onSaved: () => void }> = (props) => {
  const [location, setLocation] = createSignal(props.item.currentLocation); const [status, setStatus] = createSignal<InventoryItemStatus>(props.item.status); const [note, setNote] = createSignal(''); const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const submit = async (event: SubmitEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await recordInventoryMovement({ itemId: props.item._id, location: location(), status: status(), note: note() || undefined }); props.onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record movement'); } finally { setBusy(false); } };
  return <ModalShell label="Record item movement" eyebrow={`Scanned / ${props.item.assetCode}`} title="Confirm the handoff" description={props.item.name} onClose={props.onClose}><form class="iv-form" onSubmit={(event) => void submit(event)}><div class="iv-scanned-item"><QrMark assetCode={props.item.assetCode} /><div><strong>{props.item.name}</strong><small>Current: {props.item.currentLocation}</small></div><Status value={props.item.status} /></div><div class="iv-field-grid"><label><span>New place</span><input required value={location()} onInput={(event) => setLocation(event.currentTarget.value)} /></label><label><span>New status</span><select value={status()} onChange={(event) => setStatus(event.currentTarget.value as InventoryItemStatus)}><For each={Object.keys(statusLabels) as InventoryItemStatus[]}>{(value) => <option value={value}>{statusLabels[value]}</option>}</For></select></label></div><label><span>Movement note</span><textarea rows="2" value={note()} onInput={(event) => setNote(event.currentTarget.value)} /></label><div class="iv-recorded-by"><span>{userInitials()}</span><div><small>Recorded by</small><strong>{authStore.user()?.name ?? authStore.user()?.email}</strong></div><Icon name="check" /></div><Show when={error()}><div class="iv-form-error">{error()}</div></Show><button class="iv-primary" disabled={busy()}>{busy() ? 'Saving…' : 'Save movement'}</button></form></ModalShell>;
};

const LoanModal: Component<{ items: InventoryItem[]; selected: InventoryItem | null; onClose: () => void; onSaved: () => void }> = (props) => {
  const [itemId, setItemId] = createSignal(props.selected?._id ?? props.items[0]?._id ?? ''); const [team, setTeam] = createSignal(''); const [start, setStart] = createSignal(localDateTime(1)); const [due, setDue] = createSignal(localDateTime(5)); const [purpose, setPurpose] = createSignal(''); const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const submit = async (event: SubmitEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await createInventoryLoan({ itemId: itemId(), requesterTeam: team(), startAt: new Date(start()).getTime(), dueAt: new Date(due()).getTime(), purpose: purpose() }); props.onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create loan'); } finally { setBusy(false); } };
  return <ModalShell label="Request a loan" eyebrow="Cross-team access" title="Request a loan" description="An internal lead or inventory admin will review it." onClose={props.onClose}><Show when={props.items.length > 0} fallback={<div class="iv-modal-empty">No items are available to request.</div>}><form class="iv-form" onSubmit={(event) => void submit(event)}><label><span>Item</span><select required value={itemId()} onChange={(event) => setItemId(event.currentTarget.value)}><For each={props.items.filter((item) => item.status !== 'retired' && item.status !== 'maintenance')}>{(item) => <option value={item._id}>{item.name} · {item.assetCode}</option>}</For></select></label><label><span>Your team</span><input required placeholder="Aerodynamics" value={team()} onInput={(event) => setTeam(event.currentTarget.value)} /></label><div class="iv-field-grid"><label><span>Start</span><input required type="datetime-local" value={start()} onInput={(event) => setStart(event.currentTarget.value)} /></label><label><span>Return by</span><input required type="datetime-local" value={due()} onInput={(event) => setDue(event.currentTarget.value)} /></label></div><label><span>What is it for?</span><textarea required rows="3" value={purpose()} onInput={(event) => setPurpose(event.currentTarget.value)} /></label><div class="iv-approval-line"><b>01</b><span>Internal lead</span><i /><b>02</b><span>Inventory record</span></div><Show when={error()}><div class="iv-form-error">{error()}</div></Show><button class="iv-primary" disabled={busy()}>{busy() ? 'Sending…' : 'Send for approval'}</button></form></Show></ModalShell>;
};

const QrModal: Component<{ item: InventoryItem; onClose: () => void }> = (props) => (
  <ModalShell label="Printable QR label" eyebrow="Small-print label" title={props.item.assetCode} description="Version-minimized payload with high error correction." onClose={props.onClose}><div class="iv-qr-sheet"><div class="iv-print-label"><QrMark assetCode={props.item.assetCode} printable /><div><strong>{props.item.assetCode}</strong><span>{props.item.name}</span><small>{compactQrPayload(props.item.assetCode)}</small></div></div><dl><div><dt>Recommended print</dt><dd>24–30 mm square</dd></div><div><dt>Payload</dt><dd>{compactQrPayload(props.item.assetCode)}</dd></div><div><dt>Error correction</dt><dd>High</dd></div></dl><button class="iv-primary" onClick={() => window.print()}><Icon name="qr" />Print label</button></div></ModalShell>
);

export default InventoryPrototype;
