/**
 * SentinelVault - Industrial Enterprise Vault Controller
 * Handles complete UI state, API communications, modals, audio, and crypto operations.
 */

class SentinelApp {
    constructor() {
        this.items = [];
        this.currentView = 'all'; // 'all', 'login', 'card', 'note', 'api_key', 'identity', 'favorites', 'trash', 'audit', 'generator', 'activity', 'settings'
        this.selectedItemId = null;
        this.searchQuery = '';
        this.sortBy = 'updated';
        this.user = null;
        this.totpInterval = null;
        this.idleTimer = null;
        this.lastActivityTime = Date.now();
        this.isLocked = false;
        this.activeFormCategory = 'login';

        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.loadUserProfile();
        await this.loadVaultItems();
        this.setupAutoLock();
        this.startTotpTicker();
    }

    // --- User & Authentication ---

    async loadUserProfile() {
        try {
            const res = await fetch('/api/auth/me');
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            const data = await res.json();
            if (data.success && data.user) {
                this.user = data.user;
                this.renderUserUI();
            }
        } catch (e) {
            console.error('Failed to load user profile:', e);
        }
    }

    renderUserUI() {
        if (!this.user) return;
        const nameEl = document.getElementById('user-display-name');
        const emailEl = document.getElementById('user-display-email');
        const avatarEl = document.getElementById('user-display-avatar');

        if (nameEl) nameEl.textContent = this.user.username;
        if (emailEl) emailEl.textContent = this.user.email;
        if (avatarEl) avatarEl.textContent = this.user.username.charAt(0).toUpperCase();

        // Apply saved theme
        if (this.user.theme) {
            document.documentElement.setAttribute('data-theme', this.user.theme);
            const themeBtn = document.getElementById('btn-theme-toggle');
            if (themeBtn) {
                themeBtn.textContent = this.user.theme === 'light' ? '🌙 Dark' : '☀️ Light';
            }
        }

        // Apply sound settings
        if (typeof this.user.sound_enabled !== 'undefined') {
            window.soundEngine.enabled = !!this.user.sound_enabled;
            this.updateSoundButtonUI();
        }
        if (this.user.sound_volume) {
            window.soundEngine.setVolume(this.user.sound_volume);
        }
    }

    // --- Vault Items Loading & Filtering ---

    async loadVaultItems() {
        try {
            const isTrash = this.currentView === 'trash';
            const url = `/api/vault?deleted=${isTrash ? '1' : '0'}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.success) {
                this.items = data.items || [];
                this.updateSidebarBadges();
                this.renderCurrentView();
            }
        } catch (e) {
            console.error('Error fetching vault items:', e);
            CryptoHelper.showToast('Failed to load vault items.', 'danger');
        }
    }

    updateSidebarBadges() {
        const counts = {
            all: 0,
            login: 0,
            card: 0,
            note: 0,
            api_key: 0,
            identity: 0,
            favorites: 0
        };

        this.items.forEach(item => {
            if (!item.is_deleted) {
                counts.all++;
                if (counts[item.category] !== undefined) {
                    counts[item.category]++;
                }
                if (item.is_favorite) {
                    counts.favorites++;
                }
            }
        });

        for (const [key, val] of Object.entries(counts)) {
            const el = document.getElementById(`badge-count-${key}`);
            if (el) el.textContent = val;
        }
    }

    getFilteredItems() {
        let list = [...this.items];

        // View Filtering
        if (this.currentView === 'trash') {
            list = list.filter(i => i.is_deleted);
        } else {
            list = list.filter(i => !i.is_deleted);
            if (this.currentView === 'favorites') {
                list = list.filter(i => i.is_favorite);
            } else if (['login', 'card', 'note', 'api_key', 'identity'].includes(this.currentView)) {
                list = list.filter(i => i.category === this.currentView);
            }
        }

        // Search Query
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.trim().toLowerCase();
            list = list.filter(i => 
                (i.title && i.title.toLowerCase().includes(q)) ||
                (i.username && i.username.toLowerCase().includes(q)) ||
                (i.url && i.url.toLowerCase().includes(q)) ||
                (i.folder && i.folder.toLowerCase().includes(q)) ||
                (i.tags && i.tags.toLowerCase().includes(q))
            );
        }

        // Sorting
        list.sort((a, b) => {
            if (this.sortBy === 'title') {
                return (a.title || '').localeCompare(b.title || '');
            } else if (this.sortBy === 'created') {
                return new Date(b.created_at) - new Date(a.created_at);
            } else if (this.sortBy === 'strength') {
                return (b.strength_score || 0) - (a.strength_score || 0);
            } else {
                // Default: recently updated
                return new Date(b.updated_at) - new Date(a.updated_at);
            }
        });

        return list;
    }

    renderCurrentView() {
        // Toggle view sections
        const vaultSection = document.getElementById('view-vault-list');
        const auditSection = document.getElementById('view-security-audit');
        const generatorSection = document.getElementById('view-password-generator');
        const activitySection = document.getElementById('view-activity-log');
        const settingsSection = document.getElementById('view-settings');

        const sections = [vaultSection, auditSection, generatorSection, activitySection, settingsSection];
        sections.forEach(s => s && s.classList.add('hidden'));

        // Update active sidebar nav
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.view === this.currentView);
        });

        if (this.currentView === 'audit') {
            auditSection.classList.remove('hidden');
            this.runSecurityAudit();
        } else if (this.currentView === 'generator') {
            generatorSection.classList.remove('hidden');
            this.initStandaloneGenerator();
        } else if (this.currentView === 'activity') {
            activitySection.classList.remove('hidden');
            this.loadActivityLogs();
        } else if (this.currentView === 'settings') {
            settingsSection.classList.remove('hidden');
            this.loadSettingsUI();
        } else {
            // Vault grid views
            vaultSection.classList.remove('hidden');
            this.renderVaultGrid();
        }
    }

    renderVaultGrid() {
        const grid = document.getElementById('vault-items-grid');
        const emptyState = document.getElementById('vault-empty-state');
        const viewTitle = document.getElementById('view-current-title');
        const viewCount = document.getElementById('view-current-count');

        const filtered = this.getFilteredItems();

        // Update Title
        const titleMap = {
            all: 'All Vault Items',
            login: 'Logins & Passwords',
            card: 'Payment Cards',
            note: 'Secure Notes',
            api_key: 'API Keys & Secrets',
            identity: 'Identities & Passports',
            favorites: 'Starred Favorites',
            trash: 'Trash Bin'
        };
        if (viewTitle) viewTitle.textContent = titleMap[this.currentView] || 'Vault Items';
        if (viewCount) viewCount.textContent = `(${filtered.length})`;

        // Show/Hide Empty State
        if (filtered.length === 0) {
            grid.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        grid.innerHTML = filtered.map(item => this.renderVaultCardHTML(item)).join('');
    }

    renderVaultCardHTML(item) {
        const categoryIcons = {
            login: '🔑',
            card: '💳',
            note: '📝',
            api_key: '⚡',
            identity: '🪪'
        };

        const icon = categoryIcons[item.category] || '🔒';
        const isFav = !!item.is_favorite;
        const subtitle = item.username || item.url || (item.category === 'card' ? 'Payment Card' : 'Secure Entry');

        return `
            <div class="vault-card" onclick="app.openViewModal(${item.id})" data-id="${item.id}">
                <div class="card-top">
                    <span class="card-category-badge badge-${item.category}">
                        ${icon} ${item.category.replace('_', ' ')}
                    </span>
                    <div class="card-actions" onclick="event.stopPropagation()">
                        <button class="btn-star ${isFav ? 'starred' : ''}" 
                                onclick="app.toggleFavorite(${item.id})" 
                                title="${isFav ? 'Unfavorite' : 'Add to favorites'}">
                            ${isFav ? '★' : '☆'}
                        </button>
                    </div>
                </div>

                <div class="card-main">
                    <div class="card-avatar">${icon}</div>
                    <div class="card-info">
                        <div class="card-title">${this.escapeHTML(item.title)}</div>
                        <div class="card-subtitle">${this.escapeHTML(subtitle)}</div>
                    </div>
                </div>

                <div class="card-bottom" onclick="event.stopPropagation()">
                    <span>${item.folder || 'Personal'}</span>
                    <div class="quick-copy-group">
                        ${item.username ? `
                            <button class="btn-quick-copy" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(item.username)}', 'Username')">
                                Copy User
                            </button>
                        ` : ''}
                        ${item.password ? `
                            <button class="btn-quick-copy" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(item.password)}', 'Password')">
                                Copy Pass
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    // --- Modal Controllers ---

    openAddModal(category = 'login') {
        window.soundEngine.play('click');
        this.selectedItemId = null;
        document.getElementById('modal-item-title').textContent = 'Add New Vault Item';
        document.getElementById('form-item').reset();
        document.getElementById('input-item-id').value = '';

        this.setFormCategory(category);
        this.openModal('modal-add-item');
    }

    async openEditModal(itemId) {
        window.soundEngine.play('click');
        const item = this.items.find(i => i.id === itemId);
        if (!item) return;

        this.selectedItemId = itemId;
        document.getElementById('modal-item-title').textContent = 'Edit Vault Item';
        document.getElementById('input-item-id').value = item.id;
        document.getElementById('input-title').value = item.title || '';
        document.getElementById('input-folder').value = item.folder || 'Personal';
        document.getElementById('input-tags').value = item.tags || '';

        this.setFormCategory(item.category);

        // Fill category fields
        if (item.category === 'login') {
            document.getElementById('input-login-username').value = item.username || '';
            document.getElementById('input-login-password').value = item.password || '';
            document.getElementById('input-login-url').value = item.url || '';
            document.getElementById('input-login-totp').value = item.totp_secret || '';
            document.getElementById('input-login-notes').value = item.notes || '';
            this.handlePasswordInput(item.password || '');
        } else if (item.category === 'card') {
            const extra = item.extra || {};
            document.getElementById('input-card-holder').value = extra.holder || '';
            document.getElementById('input-card-number').value = extra.number || '';
            document.getElementById('input-card-expiry').value = extra.expiry || '';
            document.getElementById('input-card-cvv').value = extra.cvv || '';
            document.getElementById('input-card-pin').value = extra.pin || '';
            document.getElementById('input-card-notes').value = item.notes || '';
        } else if (item.category === 'note') {
            document.getElementById('input-note-content').value = item.notes || '';
        } else if (item.category === 'api_key') {
            const extra = item.extra || {};
            document.getElementById('input-api-service').value = extra.service || '';
            document.getElementById('input-api-key').value = extra.key || '';
            document.getElementById('input-api-secret').value = extra.secret || '';
            document.getElementById('input-api-notes').value = item.notes || '';
        } else if (item.category === 'identity') {
            const extra = item.extra || {};
            document.getElementById('input-id-fullname').value = extra.fullname || '';
            document.getElementById('input-id-email').value = extra.email || '';
            document.getElementById('input-id-phone').value = extra.phone || '';
            document.getElementById('input-id-number').value = extra.id_number || '';
            document.getElementById('input-id-address').value = extra.address || '';
        }

        this.closeModal('modal-view-item');
        this.openModal('modal-add-item');
    }

    setFormCategory(category) {
        this.activeFormCategory = category;
        document.querySelectorAll('.cat-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === category);
        });

        // Hide all category form groups
        document.querySelectorAll('.cat-form-group').forEach(group => {
            group.classList.add('hidden');
        });

        // Show active
        const target = document.getElementById(`cat-fields-${category}`);
        if (target) target.classList.remove('hidden');
    }

    async saveItem(e) {
        e.preventDefault();
        const itemId = document.getElementById('input-item-id').value;
        const title = document.getElementById('input-title').value.trim();
        const folder = document.getElementById('input-folder').value.trim() || 'Personal';
        const tags = document.getElementById('input-tags').value.trim();

        if (!title) {
            CryptoHelper.showToast('Please enter an item title.', 'warning');
            return;
        }

        const payload = {
            category: this.activeFormCategory,
            title,
            folder,
            tags
        };

        if (this.activeFormCategory === 'login') {
            payload.username = document.getElementById('input-login-username').value.trim();
            payload.password = document.getElementById('input-login-password').value;
            payload.url = document.getElementById('input-login-url').value.trim();
            payload.totp_secret = document.getElementById('input-login-totp').value.trim();
            payload.notes = document.getElementById('input-login-notes').value;
        } else if (this.activeFormCategory === 'card') {
            payload.extra = {
                holder: document.getElementById('input-card-holder').value.trim(),
                number: document.getElementById('input-card-number').value.trim(),
                expiry: document.getElementById('input-card-expiry').value.trim(),
                cvv: document.getElementById('input-card-cvv').value.trim(),
                pin: document.getElementById('input-card-pin').value.trim()
            };
            payload.notes = document.getElementById('input-card-notes').value;
        } else if (this.activeFormCategory === 'note') {
            payload.notes = document.getElementById('input-note-content').value;
        } else if (this.activeFormCategory === 'api_key') {
            payload.extra = {
                service: document.getElementById('input-api-service').value.trim(),
                key: document.getElementById('input-api-key').value.trim(),
                secret: document.getElementById('input-api-secret').value.trim()
            };
            payload.notes = document.getElementById('input-api-notes').value;
        } else if (this.activeFormCategory === 'identity') {
            payload.extra = {
                fullname: document.getElementById('input-id-fullname').value.trim(),
                email: document.getElementById('input-id-email').value.trim(),
                phone: document.getElementById('input-id-phone').value.trim(),
                id_number: document.getElementById('input-id-number').value.trim(),
                address: document.getElementById('input-id-address').value.trim()
            };
        }

        try {
            const method = itemId ? 'PUT' : 'POST';
            const url = itemId ? `/api/vault/${itemId}` : '/api/vault';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.success) {
                window.soundEngine.play('success');
                CryptoHelper.showToast(itemId ? 'Item updated successfully!' : 'New item saved to vault!', 'success');
                this.closeModal('modal-add-item');
                await this.loadVaultItems();
            } else {
                CryptoHelper.showToast(data.error || 'Failed to save item', 'danger');
            }
        } catch (err) {
            console.error('Save error:', err);
            CryptoHelper.showToast('Network error while saving item.', 'danger');
        }
    }

    async openViewModal(itemId) {
        window.soundEngine.play('click');
        const item = this.items.find(i => i.id === itemId);
        if (!item) return;

        this.selectedItemId = itemId;
        const container = document.getElementById('view-modal-content');
        container.innerHTML = this.renderViewModalContent(item);

        this.openModal('modal-view-item');
    }

    renderViewModalContent(item) {
        const isTrash = item.is_deleted;
        const extra = item.extra || {};

        let fieldsHTML = '';

        if (item.category === 'login') {
            fieldsHTML = `
                ${item.username ? `
                    <div class="view-detail-row">
                        <span class="detail-label">Username / Email</span>
                        <div class="detail-value-group">
                            <span class="detail-val-text font-mono">${this.escapeHTML(item.username)}</span>
                            <button class="btn-icon-only btn-secondary" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(item.username)}', 'Username')">📋</button>
                        </div>
                    </div>
                ` : ''}

                ${item.password ? `
                    <div class="view-detail-row">
                        <span class="detail-label">Password</span>
                        <div class="detail-value-group">
                            <input type="password" id="view-pass-field" class="form-control font-mono" value="${this.escapeHTML(item.password)}" readonly />
                            <button class="btn-icon-only btn-secondary" onclick="app.toggleMask('view-pass-field')">👁️</button>
                            <button class="btn-icon-only btn-secondary" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(item.password)}', 'Password')">📋</button>
                        </div>
                    </div>
                ` : ''}

                ${item.url ? `
                    <div class="view-detail-row">
                        <span class="detail-label">Website URL</span>
                        <div class="detail-value-group">
                            <a href="${this.escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer" class="link-url">
                                ${this.escapeHTML(item.url)} ↗
                            </a>
                            <button class="btn-icon-only btn-secondary" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(item.url)}', 'URL')">📋</button>
                        </div>
                    </div>
                ` : ''}

                ${item.totp_secret ? `
                    <div class="view-detail-row">
                        <span class="detail-label">Two-Factor Authenticator (TOTP)</span>
                        <div class="totp-box">
                            <div class="totp-code-large" id="view-totp-code">--- ---</div>
                            <div class="totp-timer-pie" id="view-totp-timer">30s</div>
                            <button class="btn btn-secondary btn-sm" onclick="app.copyTotpCode()">Copy Code</button>
                        </div>
                    </div>
                ` : ''}
            `;
        } else if (item.category === 'card') {
            fieldsHTML = `
                <div class="view-detail-row">
                    <span class="detail-label">Cardholder</span>
                    <span class="detail-val-text">${this.escapeHTML(extra.holder || 'N/A')}</span>
                </div>
                <div class="view-detail-row">
                    <span class="detail-label">Card Number</span>
                    <div class="detail-value-group">
                        <input type="password" id="view-card-number" class="form-control font-mono" value="${this.escapeHTML(extra.number || '')}" readonly />
                        <button class="btn-icon-only btn-secondary" onclick="app.toggleMask('view-card-number')">👁️</button>
                        <button class="btn-icon-only btn-secondary" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(extra.number || '')}', 'Card Number')">📋</button>
                    </div>
                </div>
                <div style="display:flex; gap:16px;">
                    <div class="view-detail-row" style="flex:1;">
                        <span class="detail-label">Expiry</span>
                        <span class="detail-val-text font-mono">${this.escapeHTML(extra.expiry || 'MM/YY')}</span>
                    </div>
                    <div class="view-detail-row" style="flex:1;">
                        <span class="detail-label">CVV</span>
                        <div class="detail-value-group">
                            <input type="password" id="view-card-cvv" class="form-control font-mono" style="width:70px" value="${this.escapeHTML(extra.cvv || '')}" readonly />
                            <button class="btn-icon-only btn-secondary" onclick="app.toggleMask('view-card-cvv')">👁️</button>
                        </div>
                    </div>
                </div>
            `;
        } else if (item.category === 'note') {
            fieldsHTML = `
                <div class="view-detail-row">
                    <span class="detail-label">Encrypted Note</span>
                    <div class="note-box">${this.escapeHTML(item.notes || 'No content')}</div>
                </div>
            `;
        } else if (item.category === 'api_key') {
            fieldsHTML = `
                <div class="view-detail-row">
                    <span class="detail-label">Service</span>
                    <span class="detail-val-text">${this.escapeHTML(extra.service || 'N/A')}</span>
                </div>
                <div class="view-detail-row">
                    <span class="detail-label">API Key</span>
                    <div class="detail-value-group">
                        <span class="detail-val-text font-mono">${this.escapeHTML(extra.key || '')}</span>
                        <button class="btn-icon-only btn-secondary" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(extra.key || '')}', 'API Key')">📋</button>
                    </div>
                </div>
                <div class="view-detail-row">
                    <span class="detail-label">API Secret</span>
                    <div class="detail-value-group">
                        <input type="password" id="view-api-secret" class="form-control font-mono" value="${this.escapeHTML(extra.secret || '')}" readonly />
                        <button class="btn-icon-only btn-secondary" onclick="app.toggleMask('view-api-secret')">👁️</button>
                        <button class="btn-icon-only btn-secondary" onclick="CryptoHelper.copyWithAutoClear('${this.escapeQuotes(extra.secret || '')}', 'API Secret')">📋</button>
                    </div>
                </div>
            `;
        } else if (item.category === 'identity') {
            fieldsHTML = `
                <div class="view-detail-row"><span class="detail-label">Full Name</span><span class="detail-val-text">${this.escapeHTML(extra.fullname || 'N/A')}</span></div>
                <div class="view-detail-row"><span class="detail-label">Email</span><span class="detail-val-text">${this.escapeHTML(extra.email || 'N/A')}</span></div>
                <div class="view-detail-row"><span class="detail-label">Phone</span><span class="detail-val-text">${this.escapeHTML(extra.phone || 'N/A')}</span></div>
                <div class="view-detail-row"><span class="detail-label">ID / Passport</span><span class="detail-val-text font-mono">${this.escapeHTML(extra.id_number || 'N/A')}</span></div>
                <div class="view-detail-row"><span class="detail-label">Address</span><span class="detail-val-text">${this.escapeHTML(extra.address || 'N/A')}</span></div>
            `;
        }

        if (item.notes && item.category !== 'note') {
            fieldsHTML += `
                <div class="view-detail-row">
                    <span class="detail-label">Notes</span>
                    <div class="note-box">${this.escapeHTML(item.notes)}</div>
                </div>
            `;
        }

        return `
            <div class="view-header-inline">
                <div>
                    <h2 class="modal-title">${this.escapeHTML(item.title)}</h2>
                    <span class="card-category-badge badge-${item.category}">${item.category.toUpperCase()}</span>
                </div>
                <div class="header-action-group">
                    ${!isTrash ? `
                        <button class="btn btn-secondary" onclick="app.openEditModal(${item.id})">✏️ Edit</button>
                        <button class="btn btn-danger" onclick="app.deleteItem(${item.id})">🗑️ Delete</button>
                    ` : `
                        <button class="btn btn-primary" onclick="app.restoreItem(${item.id})">♻️ Restore</button>
                        <button class="btn btn-danger" onclick="app.permanentDeleteItem(${item.id})">❌ Delete Permanently</button>
                    `}
                </div>
            </div>

            <div class="view-fields-list">
                ${fieldsHTML}
            </div>

            <div class="view-meta-footer">
                <span>Folder: <strong>${item.folder || 'Personal'}</strong></span>
                <span>Last updated: ${new Date(item.updated_at).toLocaleString()}</span>
            </div>
        `;
    }

    toggleMask(fieldId) {
        const el = document.getElementById(fieldId);
        if (el) {
            window.soundEngine.play('click');
            el.type = el.type === 'password' ? 'text' : 'password';
        }
    }

    async toggleFavorite(itemId) {
        window.soundEngine.play('click');
        try {
            const res = await fetch(`/api/vault/${itemId}/favorite`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                const item = this.items.find(i => i.id === itemId);
                if (item) item.is_favorite = !item.is_favorite;
                this.updateSidebarBadges();
                this.renderVaultGrid();
            }
        } catch (e) {
            console.error('Favorite toggle failed:', e);
        }
    }

    async deleteItem(itemId) {
        if (!confirm('Move this item to the Trash?')) return;
        window.soundEngine.play('click');
        try {
            const res = await fetch(`/api/vault/${itemId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                CryptoHelper.showToast('Item moved to Trash.', 'info');
                this.closeModal('modal-view-item');
                await this.loadVaultItems();
            }
        } catch (e) {
            CryptoHelper.showToast('Failed to delete item.', 'danger');
        }
    }

    async restoreItem(itemId) {
        window.soundEngine.play('success');
        try {
            const res = await fetch(`/api/vault/${itemId}/restore`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                CryptoHelper.showToast('Item restored to active vault!', 'success');
                this.closeModal('modal-view-item');
                await this.loadVaultItems();
            }
        } catch (e) {
            CryptoHelper.showToast('Failed to restore item.', 'danger');
        }
    }

    async permanentDeleteItem(itemId) {
        if (!confirm('PERMANENT WARNING: This action cannot be undone. Delete forever?')) return;
        window.soundEngine.play('warning');
        try {
            const res = await fetch(`/api/vault/${itemId}?permanent=1`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                CryptoHelper.showToast('Item permanently deleted.', 'warning');
                this.closeModal('modal-view-item');
                await this.loadVaultItems();
            }
        } catch (e) {
            CryptoHelper.showToast('Failed to purge item.', 'danger');
        }
    }

    async emptyTrash() {
        if (!confirm('Empty all items from Trash permanently?')) return;
        window.soundEngine.play('warning');
        try {
            const res = await fetch('/api/vault/trash/empty', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                CryptoHelper.showToast('Trash emptied.', 'info');
                await this.loadVaultItems();
            }
        } catch (e) {
            CryptoHelper.showToast('Failed to empty trash.', 'danger');
        }
    }

    // --- Interactive Password Generator ---

    initStandaloneGenerator() {
        this.updateStandaloneGenerator();
    }

    updateStandaloneGenerator() {
        const length = parseInt(document.getElementById('gen-slider-len').value, 10);
        document.getElementById('gen-len-display').textContent = length;

        const isPassphrase = document.getElementById('gen-mode-passphrase').checked;
        let password = '';

        if (isPassphrase) {
            const words = Math.max(3, Math.min(8, Math.round(length / 5)));
            password = CryptoHelper.generatePassphrase(words, '-');
        } else {
            password = CryptoHelper.generatePassword({
                length,
                upper: document.getElementById('gen-chk-upper').checked,
                lower: document.getElementById('gen-chk-lower').checked,
                digits: document.getElementById('gen-chk-digits').checked,
                symbols: document.getElementById('gen-chk-symbols').checked,
                avoidAmbiguous: document.getElementById('gen-chk-ambig').checked
            });
        }

        const passInput = document.getElementById('gen-result-password');
        if (passInput) passInput.value = password;

        const analysis = CryptoHelper.evaluatePasswordStrength(password);
        const barFill = document.getElementById('gen-strength-fill');
        const scoreLabel = document.getElementById('gen-strength-label');
        const entropyLabel = document.getElementById('gen-entropy-label');

        if (barFill) {
            barFill.style.width = analysis.width;
            barFill.style.backgroundColor = analysis.color;
        }
        if (scoreLabel) scoreLabel.textContent = analysis.label;
        if (entropyLabel) entropyLabel.textContent = `${analysis.entropy} bits entropy`;
    }

    rollNewPassword() {
        window.soundEngine.play('generate');
        this.updateStandaloneGenerator();
    }

    copyGeneratedPassword() {
        const val = document.getElementById('gen-result-password').value;
        if (val) {
            CryptoHelper.copyWithAutoClear(val, 'Generated Password');
        }
    }

    useGeneratedInNewItem() {
        const val = document.getElementById('gen-result-password').value;
        this.openAddModal('login');
        const passField = document.getElementById('input-login-password');
        if (passField) {
            passField.value = val;
            this.handlePasswordInput(val);
        }
    }

    // --- Security Audit & Health Score ---

    async runSecurityAudit() {
        window.soundEngine.play('click');
        const progressEl = document.getElementById('audit-loading-state');
        const contentEl = document.getElementById('audit-results-content');

        if (progressEl) progressEl.classList.remove('hidden');
        if (contentEl) contentEl.classList.add('hidden');

        try {
            const res = await fetch('/api/tools/audit-vault', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                this.renderAuditResults(data.audit);
            }
        } catch (e) {
            console.error('Audit failed:', e);
            CryptoHelper.showToast('Security audit encountered an error.', 'danger');
        } finally {
            if (progressEl) progressEl.classList.add('hidden');
            if (contentEl) contentEl.classList.remove('hidden');
        }
    }

    renderAuditResults(audit) {
        const scoreNum = document.getElementById('audit-score-num');
        const scoreGrade = document.getElementById('audit-score-grade');
        const scoreCircle = document.getElementById('audit-score-circle');

        if (scoreNum) scoreNum.textContent = audit.score;
        if (scoreGrade) scoreGrade.textContent = `Grade ${audit.grade}`;
        if (scoreCircle) scoreCircle.style.setProperty('--score-pct', audit.score);

        document.getElementById('metric-total-items').textContent = audit.total_items;
        document.getElementById('metric-weak-pass').textContent = audit.weak_count;
        document.getElementById('metric-reused-pass').textContent = audit.reused_count;
        document.getElementById('metric-pwned-pass').textContent = audit.pwned_count;

        // Render flagged items list
        const flaggedList = document.getElementById('audit-flagged-items');
        if (!flaggedList) return;

        if (audit.flagged && audit.flagged.length > 0) {
            flaggedList.innerHTML = audit.flagged.map(f => `
                <div class="audit-flag-card">
                    <div class="flag-icon">⚠️</div>
                    <div class="flag-details">
                        <div class="flag-title">${this.escapeHTML(f.title)}</div>
                        <div class="flag-reason font-mono">${this.escapeHTML(f.reason)}</div>
                    </div>
                    <button class="btn btn-secondary btn-sm" onclick="app.openEditModal(${f.id})">Fix Password</button>
                </div>
            `).join('');
        } else {
            flaggedList.innerHTML = `
                <div class="audit-perfect-banner">
                    <span style="font-size:32px;">🛡️</span>
                    <div>
                        <strong>Excellent Security Posture!</strong>
                        <p style="font-size:0.85rem; color:var(--text-secondary)">No breached, weak, or reused passwords detected across your vault.</p>
                    </div>
                </div>
            `;
        }
    }

    // --- Activity / Audit Logs ---

    async loadActivityLogs() {
        try {
            const res = await fetch('/api/audit-logs');
            const data = await res.json();
            if (data.success) {
                const listEl = document.getElementById('activity-logs-list');
                if (!listEl) return;

                if (!data.logs || data.logs.length === 0) {
                    listEl.innerHTML = '<div class="empty-state-desc" style="padding:40px; text-align:center;">No activity logged yet.</div>';
                    return;
                }

                listEl.innerHTML = data.logs.map(log => `
                    <div class="activity-row">
                        <div class="activity-badge badge-${log.status.toLowerCase()}">${log.status}</div>
                        <div class="activity-action">
                            <strong>${this.escapeHTML(log.action.replace('_', ' '))}</strong>
                            ${log.item_title ? `<span>- ${this.escapeHTML(log.item_title)}</span>` : ''}
                        </div>
                        <div class="activity-meta font-mono">
                            <span>${log.ip_address || '127.0.0.1'}</span>
                            <span>${new Date(log.timestamp).toLocaleString()}</span>
                        </div>
                    </div>
                `).join('');
            }
        } catch (e) {
            console.error('Failed to load audit logs:', e);
        }
    }

    async clearActivityLogs() {
        if (!confirm('Clear your security activity log history?')) return;
        window.soundEngine.play('click');
        try {
            const res = await fetch('/api/audit-logs/clear', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                CryptoHelper.showToast('Activity logs cleared.', 'info');
                this.loadActivityLogs();
            }
        } catch (e) {
            CryptoHelper.showToast('Failed to clear logs.', 'danger');
        }
    }

    // --- Settings Controller ---

    loadSettingsUI() {
        if (!this.user) return;
        const autoLockSelect = document.getElementById('setting-auto-lock');
        const soundCheck = document.getElementById('setting-sound-enabled');
        const volumeSlider = document.getElementById('setting-sound-volume');

        if (autoLockSelect && this.user.auto_lock_minutes) {
            autoLockSelect.value = this.user.auto_lock_minutes.toString();
        }
        if (soundCheck) {
            soundCheck.checked = window.soundEngine.enabled;
        }
        if (volumeSlider) {
            volumeSlider.value = window.soundEngine.volume;
        }

        const twoFaBadge = document.getElementById('setting-2fa-status');
        if (twoFaBadge) {
            twoFaBadge.textContent = this.user.two_factor_enabled ? 'Active (Enabled)' : 'Disabled';
            twoFaBadge.className = this.user.two_factor_enabled ? 'badge-success' : 'badge-warning';
        }
    }

    async savePreferences() {
        window.soundEngine.play('click');
        const autoLock = parseInt(document.getElementById('setting-auto-lock').value, 10);
        const soundEnabled = document.getElementById('setting-sound-enabled').checked;
        const volume = parseFloat(document.getElementById('setting-sound-volume').value);

        window.soundEngine.setMuted(!soundEnabled);
        window.soundEngine.setVolume(volume);

        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    auto_lock_minutes: autoLock,
                    sound_enabled: soundEnabled,
                    sound_volume: volume
                })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.play('success');
                CryptoHelper.showToast('Settings saved successfully!', 'success');
            }
        } catch (e) {
            CryptoHelper.showToast('Failed to save settings.', 'danger');
        }
    }

    async open2FASetupModal() {
        window.soundEngine.play('click');
        try {
            const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                document.getElementById('qr-code-display').innerHTML = data.qr_svg;
                document.getElementById('qr-secret-key').textContent = data.secret;
                this.openModal('modal-2fa-setup');
            } else {
                CryptoHelper.showToast(data.error || 'Failed to setup 2FA', 'danger');
            }
        } catch (e) {
            CryptoHelper.showToast('Could not initiate 2FA setup.', 'danger');
        }
    }

    async confirm2FAActivation() {
        const code = document.getElementById('input-2fa-verify-code').value.trim();
        if (!code || code.length !== 6) {
            CryptoHelper.showToast('Please enter the 6-digit code from your authenticator app.', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/auth/2fa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.play('success');
                CryptoHelper.showToast('Two-Factor Authentication is now ENABLED!', 'success');
                this.closeModal('modal-2fa-setup');
                this.user.two_factor_enabled = true;
                this.loadSettingsUI();
            } else {
                CryptoHelper.showToast(data.error || 'Invalid code. Try again.', 'danger');
            }
        } catch (e) {
            CryptoHelper.showToast('Verification failed.', 'danger');
        }
    }

    // --- Master Password Change ---

    openMasterPasswordModal() {
        window.soundEngine.play('click');
        document.getElementById('form-change-master').reset();
        this.openModal('modal-change-master');
    }

    async submitMasterPasswordChange(e) {
        e.preventDefault();
        const currentPass = document.getElementById('input-cur-master').value;
        const newPass = document.getElementById('input-new-master').value;
        const confirmPass = document.getElementById('input-confirm-master').value;

        if (newPass !== confirmPass) {
            CryptoHelper.showToast('New passwords do not match!', 'warning');
            return;
        }

        if (newPass.length < 12) {
            CryptoHelper.showToast('Master password must be at least 12 characters.', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/auth/change-master-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_password: currentPass,
                    new_password: newPass
                })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.play('success');
                CryptoHelper.showToast('Master Password changed! All vault items re-encrypted.', 'success');
                this.closeModal('modal-change-master');
            } else {
                CryptoHelper.showToast(data.error || 'Failed to change master password.', 'danger');
            }
        } catch (e) {
            CryptoHelper.showToast('Error changing master password.', 'danger');
        }
    }

    // --- Export & Import ---

    openExportModal() {
        window.soundEngine.play('click');
        document.getElementById('export-master-pass').value = '';
        this.openModal('modal-export-vault');
    }

    async executeVaultExport() {
        const pass = document.getElementById('export-master-pass').value;
        const format = document.getElementById('export-format').value;

        if (!pass) {
            CryptoHelper.showToast('Master password required for security.', 'warning');
            return;
        }

        try {
            const res = await fetch(`/api/vault/export?format=${format}&password=${encodeURIComponent(pass)}`);
            if (!res.ok) {
                const errData = await res.json();
                CryptoHelper.showToast(errData.error || 'Export verification failed.', 'danger');
                return;
            }

            const blob = await res.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = `sentinel-vault-export-${new Date().toISOString().slice(0, 10)}.${format}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(downloadUrl);

            window.soundEngine.play('success');
            CryptoHelper.showToast('Vault exported successfully!', 'success');
            this.closeModal('modal-export-vault');
        } catch (e) {
            CryptoHelper.showToast('Export failed.', 'danger');
        }
    }

    openImportModal() {
        window.soundEngine.play('click');
        document.getElementById('import-file-input').value = '';
        document.getElementById('import-raw-text').value = '';
        this.openModal('modal-import-vault');
    }

    async executeVaultImport() {
        const fileInput = document.getElementById('import-file-input');
        const rawText = document.getElementById('import-raw-text').value.trim();
        const format = document.getElementById('import-format').value;

        let content = rawText;

        if (fileInput.files.length > 0) {
            content = await fileInput.files[0].text();
        }

        if (!content) {
            CryptoHelper.showToast('Please select a file or paste content to import.', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/vault/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    format,
                    content
                })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.play('success');
                CryptoHelper.showToast(`Imported ${data.imported_count} items into vault!`, 'success');
                this.closeModal('modal-import-vault');
                await this.loadVaultItems();
            } else {
                CryptoHelper.showToast(data.error || 'Import failed.', 'danger');
            }
        } catch (e) {
            CryptoHelper.showToast('Error during vault import.', 'danger');
        }
    }

    // --- Auto-Lock & Session Locking ---

    setupAutoLock() {
        const resetTimer = () => {
            this.lastActivityTime = Date.now();
        };

        ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'].forEach(evt => {
            window.addEventListener(evt, resetTimer, { passive: true });
        });

        // Check every 10 seconds
        setInterval(() => {
            if (this.isLocked) return;
            const lockMins = (this.user && this.user.auto_lock_minutes) ? this.user.auto_lock_minutes : 15;
            if (lockMins <= 0) return; // 0 = never

            const idleMillis = Date.now() - this.lastActivityTime;
            if (idleMillis > lockMins * 60 * 1000) {
                this.lockVault();
            }
        }, 10000);
    }

    lockVault() {
        if (this.isLocked) return;
        this.isLocked = true;
        window.soundEngine.play('lock');
        const overlay = document.getElementById('lock-screen-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            document.getElementById('input-unlock-password').value = '';
            document.getElementById('input-unlock-password').focus();
        }
    }

    async submitUnlock() {
        const pass = document.getElementById('input-unlock-password').value;
        if (!pass) return;

        try {
            const res = await fetch('/api/auth/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pass })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.play('unlock');
                this.isLocked = false;
                this.lastActivityTime = Date.now();
                const overlay = document.getElementById('lock-screen-overlay');
                if (overlay) overlay.classList.add('hidden');
                CryptoHelper.showToast('Vault unlocked!', 'success');
            } else {
                window.soundEngine.play('warning');
                CryptoHelper.showToast('Invalid master password.', 'danger');
            }
        } catch (e) {
            CryptoHelper.showToast('Network error during unlock.', 'danger');
        }
    }

    // --- Live TOTP Ticker ---

    startTotpTicker() {
        setInterval(async () => {
            const timerEl = document.getElementById('view-totp-timer');
            const codeEl = document.getElementById('view-totp-code');
            if (!timerEl || !codeEl || !this.selectedItemId) return;

            const item = this.items.find(i => i.id === this.selectedItemId);
            if (!item || !item.totp_secret) return;

            const nowSec = Math.floor(Date.now() / 1000);
            const remaining = 30 - (nowSec % 30);
            timerEl.textContent = `${remaining}s`;

            if (remaining === 30 || codeEl.textContent === '--- ---') {
                try {
                    const res = await fetch(`/api/tools/totp/${item.id}`);
                    const data = await res.json();
                    if (data.success) {
                        codeEl.textContent = data.code;
                    }
                } catch (e) {}
            }
        }, 1000);
    }

    copyTotpCode() {
        const codeEl = document.getElementById('view-totp-code');
        if (codeEl && codeEl.textContent !== '--- ---') {
            CryptoHelper.copyWithAutoClear(codeEl.textContent.replace(/\s+/g, ''), 'TOTP Code');
        }
    }

    // --- UI Helpers & Event Listeners ---

    handlePasswordInput(val) {
        const analysis = CryptoHelper.evaluatePasswordStrength(val);
        const fill = document.getElementById('modal-strength-fill');
        const label = document.getElementById('modal-strength-label');
        const bits = document.getElementById('modal-entropy-label');

        if (fill) {
            fill.style.width = analysis.width;
            fill.style.backgroundColor = analysis.color;
        }
        if (label) label.textContent = analysis.label;
        if (bits) bits.textContent = `${analysis.entropy} bits`;
    }

    openModal(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('open');
    }

    closeModal(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('open');
    }

    toggleTheme() {
        window.soundEngine.play('click');
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);

        const btn = document.getElementById('btn-theme-toggle');
        if (btn) btn.textContent = next === 'light' ? '🌙 Dark' : '☀️ Light';

        fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: next })
        }).catch(() => {});
    }

    toggleSound() {
        window.soundEngine.setMuted(window.soundEngine.enabled);
        this.updateSoundButtonUI();
        fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sound_enabled: window.soundEngine.enabled })
        }).catch(() => {});
    }

    updateSoundButtonUI() {
        const btn = document.getElementById('btn-sound-toggle');
        if (btn) {
            btn.textContent = window.soundEngine.enabled ? '🔊 Sound: ON' : '🔇 Sound: OFF';
            btn.classList.toggle('active', window.soundEngine.enabled);
        }
    }

    setupEventListeners() {
        // Navigation items
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                window.soundEngine.play('tab');
                this.currentView = item.dataset.view || 'all';
                this.renderCurrentView();
            });
        });

        // Search bar
        const searchInput = document.getElementById('global-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value;
                this.renderVaultGrid();
            });
        }

        // Sort selector
        const sortSelect = document.getElementById('sort-selector');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                window.soundEngine.play('click');
                this.sortBy = e.target.value;
                this.renderVaultGrid();
            });
        }

        // Global Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl+K -> Search
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (searchInput) searchInput.focus();
            }
            // Ctrl+N -> New Item
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
                e.preventDefault();
                this.openAddModal('login');
            }
            // Ctrl+L -> Lock Vault
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
                e.preventDefault();
                this.lockVault();
            }
            // Escape -> Close all modals
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
            }
        });

        // Password input strength listener in add modal
        const passInput = document.getElementById('input-login-password');
        if (passInput) {
            passInput.addEventListener('input', (e) => this.handlePasswordInput(e.target.value));
        }

        // Close modal when clicking backdrop
        document.querySelectorAll('.modal-backdrop').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('open');
                }
            });
        });
    }

    escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    escapeQuotes(str) {
        if (!str) return '';
        return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
    }
}

// Instantiate App
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SentinelApp();
});
