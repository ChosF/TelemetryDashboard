import { getStoredSessionToken } from '@/lib/authSession';
import { getClient } from '@/lib/convex';

export type InventoryItemStatus = 'available' | 'on_loan' | 'reserved' | 'maintenance' | 'missing' | 'retired';
export type InventoryLoanStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'returned';

export interface InventoryItem {
  _id: string;
  _creationTime: number;
  assetCode: string;
  name: string;
  category: string;
  description?: string;
  homeLocation: string;
  currentLocation: string;
  status: InventoryItemStatus;
  stewardTeam?: string;
  notes?: string;
  active: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedBy: string;
  updatedByName: string;
  updatedAt: number;
}

export interface PublicInventoryItem {
  _id: string;
  assetCode: string;
  name: string;
  category: string;
  stewardTeam?: string;
  status: 'available';
}

export interface InventoryAlert {
  key: string;
  kind: 'missing' | 'overdue';
  itemId: string;
  requestId?: string;
  assetCode: string;
  itemName: string;
  requesterName?: string;
  currentLocation?: string;
  dueAt?: number;
  occurredAt: number;
}

export interface InventoryLoan {
  _id: string;
  _creationTime: number;
  itemId: string;
  assetCode: string;
  itemName: string;
  requesterUserId: string;
  requesterName: string;
  requesterEmail: string;
  requesterTeam: string;
  startAt: number;
  dueAt: number;
  purpose: string;
  status: InventoryLoanStatus;
  decisionById?: string;
  decisionByName?: string;
  decisionAt?: number;
  decisionNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InventoryMovement {
  _id: string;
  _creationTime: number;
  itemId: string;
  assetCode: string;
  fromLocation: string;
  toLocation: string;
  fromStatus: string;
  toStatus: string;
  actorUserId: string;
  actorName: string;
  actorRole: string;
  note?: string;
  createdAt: number;
}

interface InventoryClient {
  query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onUpdate: (name: string, args: Record<string, unknown>, callback: (result: unknown) => void) => () => void;
}

function client(): InventoryClient {
  const current = getClient() as InventoryClient | null;
  if (!current) throw new Error('Inventory is not connected');
  return current;
}

function token(): string {
  const current = getStoredSessionToken();
  if (!current) throw new Error('Please sign in to continue');
  return current;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    const match = error.message.match(/"message"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? error.message.replace(/^.*Uncaught ConvexError:\s*/, '');
  }
  return 'Something went wrong. Please try again.';
}

export function watchInventoryItems(onValue: (items: InventoryItem[]) => void): () => void {
  return client().onUpdate('inventory:listItems', { token: token() }, (result) => {
    onValue(result as InventoryItem[]);
  });
}

export function watchPublicInventoryItems(onValue: (items: PublicInventoryItem[]) => void): () => void {
  return client().onUpdate('inventory:listPublicAvailableItems', {}, (result) => {
    onValue(result as PublicInventoryItem[]);
  });
}

export function watchInventoryAlerts(now: number, onValue: (alerts: InventoryAlert[]) => void): () => void {
  return client().onUpdate('inventory:listAlerts', { token: token(), now }, (result) => {
    onValue(result as InventoryAlert[]);
  });
}

export function watchInventoryLoans(onValue: (loans: InventoryLoan[]) => void): () => void {
  return client().onUpdate('inventory:listLoans', { token: token() }, (result) => {
    onValue(result as InventoryLoan[]);
  });
}

export async function getItemByAssetCode(assetCode: string): Promise<InventoryItem | null> {
  return await client().query('inventory:getItemByAssetCode', {
    token: token(),
    assetCode,
  }) as InventoryItem | null;
}

export async function getInventoryItemHistory(itemId: string): Promise<InventoryMovement[]> {
  try {
    return await client().query('inventory:listItemHistory', {
      token: token(),
      itemId,
    }) as InventoryMovement[];
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function createInventoryItem(input: {
  assetCode: string;
  name: string;
  category: string;
  description?: string;
  homeLocation: string;
  stewardTeam?: string;
  notes?: string;
}): Promise<{ itemId: string; assetCode: string }> {
  try {
    return await client().mutation('inventory:createItem', { token: token(), ...input }) as {
      itemId: string;
      assetCode: string;
    };
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function recordInventoryMovement(input: {
  itemId: string;
  location: string;
  status: InventoryItemStatus;
  note?: string;
}): Promise<void> {
  try {
    await client().mutation('inventory:recordMovement', { token: token(), ...input });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function deleteInventoryItem(itemId: string): Promise<void> {
  try {
    await client().mutation('inventory:deleteItem', { token: token(), itemId });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function createInventoryLoan(input: {
  itemId: string;
  requesterTeam: string;
  startAt: number;
  dueAt: number;
  purpose: string;
}): Promise<void> {
  try {
    await client().mutation('inventory:createLoan', { token: token(), ...input });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function decideInventoryLoan(
  requestId: string,
  decision: 'approved' | 'denied',
  note?: string,
): Promise<void> {
  try {
    await client().mutation('inventory:decideLoan', { token: token(), requestId, decision, note });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function cancelInventoryLoan(requestId: string): Promise<void> {
  try {
    await client().mutation('inventory:cancelLoan', { token: token(), requestId });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function markInventoryLoanReturned(requestId: string): Promise<void> {
  try {
    await client().mutation('inventory:markLoanReturned', { token: token(), requestId });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}

export async function deleteInventoryLoan(requestId: string): Promise<void> {
  try {
    await client().mutation('inventory:deleteLoan', { token: token(), requestId });
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}
