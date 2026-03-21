export type LegacyNotificationType = 'info' | 'success' | 'warning' | 'error' | 'critical';

type AuthUiCompat = {
    showNotification?: (message: string, type?: LegacyNotificationType, duration?: number) => HTMLElement | void;
};

declare global {
    interface Window {
        AuthUI?: AuthUiCompat & Record<string, unknown>;
    }
}

let notificationStack: HTMLElement[] = [];

function getIconSvg(type: LegacyNotificationType): string {
    const iconColors: Record<LegacyNotificationType, string> = {
        error: '#F44336',
        critical: '#D32F2F',
        warning: '#FF9800',
        success: '#4CAF50',
        info: '#2196F3',
    };
    const iconColor = iconColors[type] ?? iconColors.info;

    if (type === 'critical') {
        return `
        <svg class="custom-notification-icon-svg" width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 4L38 36H2L20 4Z" stroke="${iconColor}" stroke-width="2" fill="none"/>
          <path d="M20 16V24M20 28V30" stroke="${iconColor}" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      `;
    }

    return `
      <svg class="custom-notification-icon-svg" width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="18" stroke="${iconColor}" stroke-width="2" fill="none"/>
        <path d="M20 12V14M20 18V28" stroke="${iconColor}" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    `;
}

export function showLegacyNotification(
    message: string,
    type: LegacyNotificationType = 'info',
    duration = 5000
): HTMLElement | void {
    if (typeof document === 'undefined') return;

    if (window.AuthUI?.showNotification && window.AuthUI.showNotification !== showLegacyNotification) {
        return window.AuthUI.showNotification(message, type, duration);
    }

    notificationStack = notificationStack.filter((node) => document.body.contains(node));

    const notification = document.createElement('div');
    notification.className = `custom-notification custom-notification-${type}`;
    notification.innerHTML = `
      <div class="custom-notification-content">
        <span class="custom-notification-icon">${getIconSvg(type)}</span>
        <span class="custom-notification-message">${message}</span>
        <button class="custom-notification-ok" aria-label="OK">OK</button>
      </div>
    `;

    const stackOffset = notificationStack.length * 90;
    notification.style.setProperty('--stack-offset', `${stackOffset}px`);
    document.body.appendChild(notification);
    notificationStack.push(notification);

    const close = () => {
        notification.classList.add('closing');
        const index = notificationStack.indexOf(notification);
        if (index > -1) {
            notificationStack.splice(index, 1);
            notificationStack.forEach((item, itemIndex) => {
                item.style.setProperty('--stack-offset', `${itemIndex * 90}px`);
            });
        }
        window.setTimeout(() => notification.remove(), 300);
    };

    notification.querySelector('.custom-notification-ok')?.addEventListener('click', close);

    if (duration > 0) {
        window.setTimeout(close, duration);
    }

    return notification;
}

export function ensureLegacyNotificationApi(): void {
    if (typeof window === 'undefined') return;
    window.AuthUI = window.AuthUI ?? {};
    if (!window.AuthUI.showNotification) {
        window.AuthUI.showNotification = showLegacyNotification;
    }
}

