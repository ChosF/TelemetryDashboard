/* auth-ui.js — Authentication UI components
   - Login modal
   - Sign up modal
   - Admin dashboard
   - User approval banner
*/

(function () {
  "use strict";

  // Custom notification system - stack multiple notifications
  let notificationStack = [];

  function showNotification(message, type = 'info', duration = 5000) {
    // Clean up old notifications from stack
    notificationStack = notificationStack.filter(n => document.body.contains(n));

    const notification = document.createElement('div');
    notification.className = `custom-notification custom-notification-${type}`;

    // Color mapping for notification types
    const iconColors = {
      error: '#F44336',
      warning: '#FF9800',
      success: '#4CAF50',
      info: '#2196F3'
    };
    const iconColor = iconColors[type] || iconColors.info;

    // SVG icon - minimal "i" in a circle, same design for all types
    const iconSvg = `
      <svg class="custom-notification-icon-svg" width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="18" stroke="${iconColor}" stroke-width="2" fill="none"/>
        <path d="M20 12V14M20 18V28" stroke="${iconColor}" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    `;

    notification.innerHTML = `
      <div class="custom-notification-content">
        <span class="custom-notification-icon">${iconSvg}</span>
        <span class="custom-notification-message">${message}</span>
        <button class="custom-notification-ok" aria-label="OK">OK</button>
      </div>
    `;

    // Calculate position based on existing notifications (stack vertically from top)
    const stackOffset = notificationStack.length * 90;
    notification.style.setProperty('--stack-offset', `${stackOffset}px`);

    document.body.appendChild(notification);
    notificationStack.push(notification);

    const okBtn = notification.querySelector('.custom-notification-ok');
    const close = () => {
      notification.classList.add('closing');
      // Remove from stack
      const idx = notificationStack.indexOf(notification);
      if (idx > -1) {
        notificationStack.splice(idx, 1);
        // Reposition remaining notifications
        notificationStack.forEach((n, i) => {
          const offset = i * 90;
          n.style.setProperty('--stack-offset', `${offset}px`);
        });
      }
      setTimeout(() => notification.remove(), 300);
    };

    okBtn.addEventListener('click', close);

    // Auto-close after duration
    if (duration > 0) {
      // Set progress bar animation duration dynamically
      notification.style.setProperty('--notification-duration', `${duration}ms`);
      setTimeout(close, duration);
    }

    return notification;
  }

  // Custom confirmation dialog
  function showConfirm(message, onConfirm, onCancel) {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-modal-overlay"></div>
      <div class="confirm-modal-content glass-panel">
        <div class="confirm-modal-icon">⚠️</div>
        <div class="confirm-modal-message">${message}</div>
        <div class="confirm-modal-actions">
          <button class="confirm-cancel liquid-hover">Cancel</button>
          <button class="confirm-ok liquid-hover">Confirm</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const overlay = modal.querySelector('.confirm-modal-overlay');
    const cancelBtn = modal.querySelector('.confirm-cancel');
    const okBtn = modal.querySelector('.confirm-ok');

    const close = (confirmed) => {
      modal.classList.add('closing');
      setTimeout(() => {
        modal.remove();
        if (confirmed && onConfirm) {
          onConfirm();
        } else if (!confirmed && onCancel) {
          onCancel();
        }
      }, 300);
    };

    overlay.addEventListener('click', () => close(false));
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));

    // ESC key support
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close(false);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    return modal;
  }

  // Create and show login modal
  function showLoginModal() {
    const modal = createAuthModal('login');
    document.body.appendChild(modal);

    // Focus email input
    setTimeout(() => {
      modal.querySelector('#auth-email')?.focus();
    }, 100);
  }

  // Create and show signup modal
  function showSignupModal() {
    const modal = createAuthModal('signup');
    document.body.appendChild(modal);

    // Focus email input
    setTimeout(() => {
      modal.querySelector('#auth-email')?.focus();
    }, 100);
  }

  // Create auth modal (login or signup)
  function createAuthModal(type = 'login') {
    const isLogin = type === 'login';

    const modal = document.createElement('div');
    modal.className = 'auth-modal';
    modal.innerHTML = `
      <div class="auth-modal-overlay"></div>
      <div class="auth-modal-content glass-panel">
        <button class="auth-modal-close liquid-hover" aria-label="Close">×</button>
        
        <div class="auth-modal-header">
          <h2 class="auth-modal-title">${isLogin ? 'Welcome Back' : 'Create Account'}</h2>
          <p class="auth-modal-subtitle">${isLogin ? 'Sign in to access your dashboard' : 'Join the Shell Eco-marathon team'}</p>
        </div>

        <form class="auth-form" id="auth-form">
          ${!isLogin ? `
            <div class="form-group">
              <label for="auth-name" class="form-label">Name</label>
              <input 
                type="text" 
                id="auth-name" 
                class="form-input" 
                placeholder="Your full name"
                required
                autocomplete="name"
              />
            </div>
          ` : ''}
          
          <div class="form-group">
            <label for="auth-email" class="form-label">Email</label>
            <input 
              type="email" 
              id="auth-email" 
              class="form-input" 
              placeholder="you@example.com"
              required
              autocomplete="email"
            />
          </div>

          <div class="form-group">
            <label for="auth-password" class="form-label">Password</label>
            <input 
              type="password" 
              id="auth-password" 
              class="form-input" 
              placeholder="${isLogin ? 'Enter your password' : 'Create a password (min 6 characters)'}"
              required
              autocomplete="${isLogin ? 'current-password' : 'new-password'}"
              minlength="6"
            />
          </div>

          ${!isLogin ? `
            <div class="form-group">
              <label for="auth-role" class="form-label">Account Type</label>
              <select id="auth-role" class="form-select">
                <option value="external_user">External User</option>
                <option value="internal_user">Internal User - EcoVolt Members (Requires Approval)</option>
              </select>
              <p class="form-help">
                <strong>External:</strong> Download up to 400 data points, view last session<br>
                <strong>Internal (EcoVolt):</strong> Full access (pending approval)
              </p>
            </div>
          ` : ''}

          ${isLogin ? `
            <div class="form-group form-checkbox">
              <label class="checkbox-label">
                <input type="checkbox" id="auth-remember" class="checkbox-input" />
                <span class="checkbox-text">Remember me</span>
              </label>
            </div>
          ` : ''}

          <div class="auth-error" id="auth-error" style="display: none;"></div>

          <button type="submit" class="auth-submit-btn liquid-hover">
            ${isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div class="auth-modal-footer">
          <p class="auth-switch-text">
            ${isLogin ? "Don't have an account?" : "Already have an account?"}
            <button class="auth-switch-btn liquid-hover" type="button">
              ${isLogin ? 'Sign Up' : 'Sign In'}
            </button>
          </p>
        </div>
      </div>
    `;

    // Close modal handlers
    const closeBtn = modal.querySelector('.auth-modal-close');
    const overlay = modal.querySelector('.auth-modal-overlay');
    let isClosing = false;

    const closeModal = (callback) => {
      if (isClosing) return;
      isClosing = true;
      modal.classList.add('closing');
      // Immediately hide to prevent flash
      modal.style.pointerEvents = 'none';
      setTimeout(() => {
        modal.remove();
        if (callback) callback();
      }, 280);
    };

    closeBtn.addEventListener('click', () => closeModal());
    overlay.addEventListener('click', () => closeModal());

    // Switch between login and signup
    const switchBtn = modal.querySelector('.auth-switch-btn');
    switchBtn.addEventListener('click', () => {
      closeModal(() => {
        // Open new modal after current one is fully removed
        setTimeout(() => {
          if (isLogin) {
            showSignupModal();
          } else {
            showLoginModal();
          }
        }, 20);
      });
    });

    // Form submission
    const form = modal.querySelector('#auth-form');
    const errorDiv = modal.querySelector('#auth-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = modal.querySelector('#auth-email').value;
      const password = modal.querySelector('#auth-password').value;
      const submitBtn = form.querySelector('.auth-submit-btn');

      // Disable submit button
      submitBtn.disabled = true;
      submitBtn.textContent = isLogin ? 'Signing in...' : 'Creating account...';
      errorDiv.style.display = 'none';

      try {
        let result;

        if (isLogin) {
          const rememberMe = modal.querySelector('#auth-remember')?.checked || false;
          result = await window.AuthModule.signIn(email, password, rememberMe);
        } else {
          const role = modal.querySelector('#auth-role').value;
          const name = modal.querySelector('#auth-name')?.value || null;
          result = await window.AuthModule.signUp(email, password, role, name);
        }

        if (result.success) {
          // Show success message
          if (!isLogin && result.needsApproval) {
            showNotification('Request submitted! An admin will review your EcoVolt team access. For now, you have External User privileges.', 'info', 8000);
            showApprovalBanner();
          } else if (!isLogin) {
            showNotification('Account created! Welcome to the EcoVolt telemetry dashboard.', 'success');
          }
          closeModal();
        } else {
          throw new Error(result.error || 'Authentication failed');
        }
      } catch (error) {
        console.error('Auth error:', error);
        errorDiv.textContent = error.message || 'An error occurred. Please try again.';
        errorDiv.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = isLogin ? 'Sign In' : 'Create Account';
      }
    });

    // Add enter key support
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    });

    return modal;
  }

  // Show approval pending banner
  function showApprovalBanner() {
    // Remove existing banner if any
    const existing = document.querySelector('.approval-banner');
    if (existing) {
      existing.remove();
    }

    const banner = document.createElement('div');
    banner.className = 'approval-banner glass-panel';
    banner.innerHTML = `
      <div class="approval-banner-content">
        <span class="approval-banner-icon">⏳</span>
        <div class="approval-banner-text">
          <strong>Awaiting Team Access</strong>
          <p>Your request is under review. You have External User access in the meantime.</p>
        </div>
        <button class="approval-banner-close liquid-hover" aria-label="Dismiss">×</button>
      </div>
    `;

    const closeBtn = banner.querySelector('.approval-banner-close');
    closeBtn.addEventListener('click', () => {
      banner.classList.add('closing');
      setTimeout(() => banner.remove(), 300);
    });

    document.body.appendChild(banner);
  }

  // Create and show admin dashboard
  function showAdminDashboard() {
    if (!window.AuthModule.hasPermission('canAccessAdmin')) {
      showNotification('You do not have permission to access the admin dashboard.', 'error');
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'admin-modal';
    modal.innerHTML = `
      <div class="admin-modal-overlay"></div>
      <div class="admin-modal-content glass-panel">
        <button class="admin-modal-close liquid-hover" aria-label="Close">×</button>
        
        <div class="admin-modal-header">
          <h2 class="admin-modal-title">👥 User Management</h2>
          <p class="admin-modal-subtitle">Manage user roles and approvals</p>
        </div>

        <div class="admin-tabs">
          <button class="admin-tab active" data-tab="pending">
            <span class="admin-tab-icon">⏳</span>
            <span class="admin-tab-label">Pending Approvals</span>
            <span class="admin-tab-badge" id="pending-count">0</span>
          </button>
          <button class="admin-tab" data-tab="all">
            <span class="admin-tab-icon">👥</span>
            <span class="admin-tab-label">All Users</span>
          </button>
        </div>

        <div class="admin-content">
          <div class="admin-panel active" id="admin-pending" style="display: block;">
            <div class="admin-loading">Loading...</div>
          </div>
          <div class="admin-panel" id="admin-all" style="display: none;">
            <div class="admin-loading">Loading...</div>
          </div>
        </div>
      </div>
    `;

    // Close modal handlers
    const closeBtn = modal.querySelector('.admin-modal-close');
    const overlay = modal.querySelector('.admin-modal-overlay');
    let isClosing = false;

    const closeModal = () => {
      if (isClosing) return;
      isClosing = true;
      modal.classList.add('closing');
      // Immediately hide to prevent flash
      modal.style.pointerEvents = 'none';
      setTimeout(() => modal.remove(), 280);
    };

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);

    // Tab switching
    const tabs = modal.querySelectorAll('.admin-tab');
    const panels = modal.querySelectorAll('.admin-panel');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;

        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => {
          p.classList.remove('active');
          p.style.display = 'none';
        });

        tab.classList.add('active');
        const activePanel = modal.querySelector(`#admin-${targetTab}`);
        activePanel.classList.add('active');
        activePanel.style.display = 'block';
      });
    });

    document.body.appendChild(modal);

    // Load pending users
    loadPendingUsers(modal);
    loadAllUsers(modal);

    return modal;
  }

  // Load pending users
  async function loadPendingUsers(modal) {
    const container = modal.querySelector('#admin-pending');

    try {
      const users = await window.AuthModule.getPendingUsers();

      modal.querySelector('#pending-count').textContent = users.length;

      if (users.length === 0) {
        container.innerHTML = `
          <div class="admin-empty">
            <span class="admin-empty-icon">✅</span>
            <p class="admin-empty-text">No pending approvals</p>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="admin-users-list">
          ${users.map(user => createUserCard(user, true)).join('')}
        </div>
      `;

      // Add event listeners for approve/reject buttons
      container.querySelectorAll('.admin-user-approve').forEach(btn => {
        btn.addEventListener('click', async () => {
          const userId = btn.dataset.userId;
          const role = btn.dataset.role;
          await approveUser(userId, role, modal);
        });
      });

      container.querySelectorAll('.admin-user-reject').forEach(btn => {
        btn.addEventListener('click', async () => {
          const userId = btn.dataset.userId;
          await rejectUser(userId, modal);
        });
      });
    } catch (error) {
      console.error('Error loading pending users:', error);
      container.innerHTML = `
        <div class="admin-error">
          <p>Error loading pending users: ${error.message}</p>
        </div>
      `;
    }
  }

  // Load all users
  async function loadAllUsers(modal) {
    const container = modal.querySelector('#admin-all');

    try {
      const users = await window.AuthModule.getAllUsers();

      if (users.length === 0) {
        container.innerHTML = `
          <div class="admin-empty">
            <span class="admin-empty-icon">👤</span>
            <p class="admin-empty-text">No users found</p>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="admin-users-list">
          ${users.map(user => createUserCard(user, false)).join('')}
        </div>
      `;

      // Add event listeners for role change
      container.querySelectorAll('.admin-user-role-select').forEach(select => {
        select.addEventListener('change', async (e) => {
          const userId = e.target.dataset.userId;
          const newRole = e.target.value;
          await changeUserRole(userId, newRole, modal);
        });
      });
    } catch (error) {
      console.error('Error loading all users:', error);
      container.innerHTML = `
        <div class="admin-error">
          <p>Error loading users: ${error.message}</p>
        </div>
      `;
    }
  }

  // Create user card HTML
  function createUserCard(user, isPending) {
    const roleLabels = {
      'guest': 'Guest',
      'external_user': 'External User',
      'internal_user': 'Internal User',
      'admin': 'Admin'
    };

    const statusBadge = user.approval_status === 'pending' ?
      '<span class="status-badge pending">Pending</span>' :
      user.approval_status === 'rejected' ?
        '<span class="status-badge rejected">Rejected</span>' :
        '<span class="status-badge approved">Approved</span>';

    if (isPending) {
      return `
        <div class="admin-user-card glass-panel">
          <div class="admin-user-info">
            <div class="admin-user-avatar">${user.email.charAt(0).toUpperCase()}</div>
            <div class="admin-user-details">
              <div class="admin-user-email">${user.email}</div>
              <div class="admin-user-meta">
                Requested: <strong>${roleLabels[user.requested_role]}</strong>
                <span class="admin-user-date">• ${formatDate(user.created_at)}</span>
              </div>
            </div>
          </div>
          <div class="admin-user-actions">
            <button 
              class="admin-user-approve liquid-hover" 
              data-user-id="${user.user_id}"
              data-role="${user.requested_role}"
            >
              ✓ Approve
            </button>
            <button 
              class="admin-user-reject liquid-hover" 
              data-user-id="${user.user_id}"
            >
              × Reject
            </button>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="admin-user-card glass-panel">
          <div class="admin-user-info">
            <div class="admin-user-avatar">${user.email.charAt(0).toUpperCase()}</div>
            <div class="admin-user-details">
              <div class="admin-user-email">${user.email}</div>
              <div class="admin-user-meta">
                ${statusBadge}
                <span class="admin-user-date">• ${formatDate(user.created_at)}</span>
              </div>
            </div>
          </div>
          <div class="admin-user-role">
            <select class="admin-user-role-select form-select" data-user-id="${user.user_id}">
              <option value="guest" ${user.role === 'guest' ? 'selected' : ''}>Guest</option>
              <option value="external_user" ${user.role === 'external_user' ? 'selected' : ''}>External User</option>
              <option value="internal_user" ${user.role === 'internal_user' ? 'selected' : ''}>Internal User</option>
              <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          </div>
        </div>
      `;
    }
  }

  // Approve user
  async function approveUser(userId, role, modal) {
    try {
      await window.AuthModule.updateUserRole(userId, role);
      // Reload both panels
      loadPendingUsers(modal);
      loadAllUsers(modal);
      showNotification('User approved successfully!', 'success');
    } catch (error) {
      console.error('Error approving user:', error);
      showNotification('Failed to approve user: ' + error.message, 'error');
    }
  }

  // Reject user
  async function rejectUser(userId, modal) {
    showConfirm('Are you sure you want to reject this user request?', async () => {
      try {
        await window.AuthModule.rejectUser(userId);
        // Reload both panels
        loadPendingUsers(modal);
        loadAllUsers(modal);
        showNotification('User request rejected.', 'success');
      } catch (error) {
        console.error('Error rejecting user:', error);
        showNotification('Failed to reject user: ' + error.message, 'error');
      }
    });
  }

  // Change user role
  async function changeUserRole(userId, newRole, modal) {
    try {
      await window.AuthModule.updateUserRole(userId, newRole);
      // Reload all users panel
      loadAllUsers(modal);
      showNotification('User role updated successfully!', 'success');
    } catch (error) {
      console.error('Error changing user role:', error);
      showNotification('Failed to change user role: ' + error.message, 'error');
      // Reload to reset select
      loadAllUsers(modal);
    }
  }

  // Format date
  function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  // Update header UI based on auth state
  function updateHeaderUI() {
    // Try to find header-actions container first, fallback to hero-content
    let header = document.querySelector('.header-actions');
    if (!header) {
      header = document.querySelector('.hero-header .hero-content');
    }
    if (!header) return;

    // Remove existing auth buttons
    const existingAuthBtns = header.querySelector('.header-auth-buttons');
    if (existingAuthBtns) {
      existingAuthBtns.remove();
    }

    // Always show login/signup buttons if not authenticated
    // Even if AuthModule is not available, allow user to try logging in
    const isAuth = window.AuthModule ? window.AuthModule.isAuthenticated() : false;
    const user = window.AuthModule ? window.AuthModule.getCurrentUser() : null;
    const profile = window.AuthModule ? window.AuthModule.getCurrentProfile() : null;

    if (isAuth && user) {
      // Show enhanced account menu with View Transitions API
      const fullName = profile?.name || user.user_metadata?.name || user.email;
      const isAdmin = window.AuthModule.hasPermission('canAccessAdmin');

      const authButtons = document.createElement('div');
      authButtons.className = 'header-auth-buttons';
      authButtons.innerHTML = `
        <div class="enhanced-account-menu" id="enhanced-account-menu">
          <button class="account-trigger liquid-hover" id="account-trigger" aria-label="Account menu" aria-expanded="false">
            <span class="account-avatar">${fullName.charAt(0).toUpperCase()}</span>
          </button>
          <div class="account-actions" id="account-actions">
            ${isAdmin ? `
              <button class="account-action liquid-hover" id="admin-dashboard-action" aria-label="Dashboard" data-tooltip="Dashboard">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
              </button>
            ` : ''}
            <button class="account-action logout-action liquid-hover" id="logout-action" aria-label="Sign out" data-tooltip="Sign out">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
            </button>
          </div>
        </div>
      `;

      header.appendChild(authButtons);

      // Enhanced menu toggle with View Transitions API
      const menuContainer = authButtons.querySelector('#enhanced-account-menu');
      const trigger = authButtons.querySelector('#account-trigger');
      const actions = authButtons.querySelector('#account-actions');

      let isExpanded = false;

      trigger.addEventListener('click', async (e) => {
        e.stopPropagation();

        // Toggle expanded state with smooth CSS transitions
        isExpanded = !isExpanded;
        menuContainer.classList.toggle('expanded', isExpanded);
        trigger.setAttribute('aria-expanded', isExpanded.toString());
      });

      // Close menu when clicking outside
      const closeMenu = () => {
        if (isExpanded) {
          isExpanded = false;
          menuContainer.classList.remove('expanded');
          trigger.setAttribute('aria-expanded', 'false');
        }
      };

      document.addEventListener('click', (e) => {
        if (!menuContainer.contains(e.target)) {
          closeMenu();
        }
      });

      // Close menu on scroll
      window.addEventListener('scroll', closeMenu, { passive: true });

      // Admin dashboard button
      if (isAdmin) {
        const adminBtn = authButtons.querySelector('#admin-dashboard-action');
        adminBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeMenu();
          showAdminDashboard();
        });
      }

      // Sign out button
      const logoutBtn = authButtons.querySelector('#logout-action');
      logoutBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeMenu();
        await window.AuthModule.signOut();
      });

      // Show approval banner if needed
      if (window.AuthModule.needsApproval()) {
        showApprovalBanner();
      }
    } else {
      // Show single account icon button
      const authButtons = document.createElement('div');
      authButtons.className = 'header-auth-buttons';
      authButtons.innerHTML = `
        <button class="header-account-icon liquid-hover" id="header-account-btn" title="Sign In">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
        </button>
      `;

      header.appendChild(authButtons);

      // Account button opens login modal
      const accountBtn = authButtons.querySelector('#header-account-btn');
      accountBtn.addEventListener('click', showLoginModal);
    }
  }

  // Get role label
  function getRoleLabel(role) {
    const labels = {
      'guest': 'Guest',
      'external_user': 'External User',
      'internal_user': 'Internal User',
      'admin': 'Admin'
    };
    return labels[role] || 'Guest';
  }

  // Add admin option to FAB menu
  function addAdminToFAB() {
    // Admin button removed from FAB as per design requirements
    // The admin dashboard is accessible via the profile menu
    /*
    const fabOptions = document.querySelector('#fab-options');
    if (!fabOptions) return;

    // Remove existing admin button if any
    const existingAdminBtn = fabOptions.querySelector('#fab-admin');
    if (existingAdminBtn) {
      existingAdminBtn.remove();
    }

    // Only add if user is admin
    if (window.AuthModule.hasPermission('canAccessAdmin')) {
      const adminBtn = document.createElement('button');
      adminBtn.id = 'fab-admin';
      adminBtn.className = 'fab-option liquid-hover';
      adminBtn.setAttribute('data-tooltip', 'Admin');
      adminBtn.innerHTML = '<span>👥</span>';

      adminBtn.addEventListener('click', showAdminDashboard);

      // Insert before sessions button
      const sessionsBtn = fabOptions.querySelector('#fab-sessions');
      if (sessionsBtn) {
        fabOptions.insertBefore(adminBtn, sessionsBtn);
      } else {
        fabOptions.appendChild(adminBtn);
      }
    }
    */
  }

  // Track previous role for detecting role upgrades
  let previousRole = null;

  // Initialize auth UI
  function initAuthUI() {
    // Always initialize UI, even if AuthModule is not available
    // This allows login buttons to be shown, and errors will appear if Supabase is not configured

    // Update header on auth state change and detect role upgrades
    window.addEventListener('auth-state-changed', (e) => {
      const profile = e.detail?.profile;
      const currentRole = profile?.role;

      // Detect role upgrade to internal_user (user was approved)
      if (previousRole && currentRole === 'internal_user' &&
        (previousRole === 'external_user' || previousRole === 'guest')) {
        showNotification('Welcome to the team! Your Internal User access has been approved. 🎉', 'success', 8000);
        // Remove approval banner if present
        const banner = document.querySelector('.approval-banner');
        if (banner) {
          banner.classList.add('closing');
          setTimeout(() => banner.remove(), 300);
        }
      }

      previousRole = currentRole;
      updateHeaderUI();
      addAdminToFAB();
    });

    // Initial UI update - always show login buttons
    updateHeaderUI();
    addAdminToFAB();
  }

  // Export auth UI module
  window.AuthUI = {
    showLoginModal,
    showSignupModal,
    showAdminDashboard,
    showApprovalBanner,
    updateHeaderUI,
    initAuthUI,
    showNotification,
    showConfirm
  };
})();
