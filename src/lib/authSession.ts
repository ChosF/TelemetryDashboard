const AUTH_STORAGE_KEY = 'ecovolt_auth_session_v2';
const LEGACY_AUTH_STORAGE_KEYS = ['convex_auth_token', 'auth_session_token'] as const;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function safeGet(storage: Storage, key: string): string | null {
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

function safeRemove(storage: Storage, key: string): void {
    try {
        storage.removeItem(key);
    } catch {
        // Storage can be disabled by browser privacy settings.
    }
}

export function clearStoredSessionToken(): void {
    safeRemove(localStorage, AUTH_STORAGE_KEY);
    safeRemove(sessionStorage, AUTH_STORAGE_KEY);
    for (const key of LEGACY_AUTH_STORAGE_KEYS) {
        safeRemove(localStorage, key);
        safeRemove(sessionStorage, key);
    }
}

export function getStoredSessionToken(): string | null {
    const token = safeGet(localStorage, AUTH_STORAGE_KEY)
        ?? safeGet(sessionStorage, AUTH_STORAGE_KEY);
    for (const key of LEGACY_AUTH_STORAGE_KEYS) {
        safeRemove(localStorage, key);
        safeRemove(sessionStorage, key);
    }
    if (!token) return null;
    if (!SESSION_TOKEN_PATTERN.test(token)) {
        clearStoredSessionToken();
        return null;
    }
    return token;
}

export function persistSessionToken(token: string, rememberMe: boolean): void {
    if (!SESSION_TOKEN_PATTERN.test(token)) {
        throw new Error('The server returned an invalid session token');
    }

    clearStoredSessionToken();
    const storage = rememberMe ? localStorage : sessionStorage;
    try {
        storage.setItem(AUTH_STORAGE_KEY, token);
    } catch {
        throw new Error('Your browser blocked session storage');
    }
}

export function isAuthStorageEvent(event: StorageEvent): boolean {
    return event.key === AUTH_STORAGE_KEY || event.key === null;
}
