/**
 * SentinelVault - Cryptographic and Security Utilities
 */

const CryptoHelper = {
    clipboardTimer: null,
    clipboardSecondsLeft: 0,

    /**
     * Copy text to clipboard with pleasant feedback and automatic 30s auto-wipe
     */
    async copyWithAutoClear(text, label = "Password") {
        if (!text) return;

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                // Fallback for non-https or older browsers
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = "fixed";
                textArea.style.left = "-999999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
            }

            if (window.soundEngine) {
                window.soundEngine.play('copy');
            }

            this.startClipboardAutoClear(label);
        } catch (err) {
            console.error('Clipboard copy failed:', err);
            this.showToast('Copy failed. Please copy manually.', 'danger');
        }
    },

    /**
     * Start the 30-second security countdown to wipe clipboard
     */
    startClipboardAutoClear(label = "Secret") {
        if (this.clipboardTimer) {
            clearInterval(this.clipboardTimer);
        }

        this.clipboardSecondsLeft = 30;
        const toastEl = document.getElementById('clipboard-toast');
        const labelEl = document.getElementById('clipboard-toast-label');
        const timerEl = document.getElementById('clipboard-toast-timer');
        const progressEl = document.getElementById('clipboard-toast-progress');

        if (!toastEl) return;

        labelEl.textContent = `${label} copied!`;
        timerEl.textContent = `Auto-clearing in ${this.clipboardSecondsLeft}s`;
        progressEl.style.width = '100%';
        toastEl.classList.remove('hidden');
        toastEl.classList.add('visible');

        this.clipboardTimer = setInterval(() => {
            this.clipboardSecondsLeft--;
            if (timerEl) {
                timerEl.textContent = `Auto-clearing in ${this.clipboardSecondsLeft}s`;
            }
            if (progressEl) {
                progressEl.style.width = `${(this.clipboardSecondsLeft / 30) * 100}%`;
            }

            if (this.clipboardSecondsLeft <= 0) {
                this.wipeClipboard();
            }
        }, 1000);
    },

    /**
     * Securely wipe clipboard
     */
    async wipeClipboard() {
        if (this.clipboardTimer) {
            clearInterval(this.clipboardTimer);
            this.clipboardTimer = null;
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText('');
            }
        } catch (e) {
            // Best effort
        }

        const toastEl = document.getElementById('clipboard-toast');
        if (toastEl) {
            toastEl.classList.remove('visible');
            setTimeout(() => toastEl.classList.add('hidden'), 300);
        }

        this.showToast('🔒 Clipboard wiped for security.', 'info', 3000);
    },

    /**
     * Generic Toast Notification
     */
    showToast(message, type = 'info', duration = 3500) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type} animate-slide-in`;
        
        let icon = 'ℹ️';
        if (type === 'success') icon = '✅';
        if (type === 'warning') icon = '⚠️';
        if (type === 'danger') icon = '❌';

        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <span class="toast-message">${message}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 400);
        }, duration);
    },

    /**
     * Real-time NIST entropy & strength evaluation
     */
    evaluatePasswordStrength(password) {
        if (!password) {
            return { entropy: 0, score: 0, label: 'Empty', color: 'var(--color-danger)', width: '0%' };
        }

        let pool = 0;
        if (/[a-z]/.test(password)) pool += 26;
        if (/[A-Z]/.test(password)) pool += 26;
        if (/[0-9]/.test(password)) pool += 10;
        if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
        if (pool === 0) pool = 26;

        const entropy = password.length * Math.log2(pool);

        let score = 0;
        let label = 'Very Weak';
        let color = '#ef4444';
        let width = '20%';

        if (password.length >= 8 && entropy >= 30) {
            score = 1;
            label = 'Weak';
            color = '#f97316';
            width = '40%';
        }
        if (password.length >= 12 && entropy >= 52) {
            score = 2;
            label = 'Moderate';
            color = '#eab308';
            width = '65%';
        }
        if (password.length >= 14 && entropy >= 72 && pool >= 60) {
            score = 3;
            label = 'Strong';
            color = '#10b981';
            width = '85%';
        }
        if (password.length >= 18 && entropy >= 90 && pool >= 80) {
            score = 4;
            label = 'Military Grade';
            color = '#00f0ff';
            width = '100%';
        }

        return {
            entropy: Math.round(entropy),
            score,
            label,
            color,
            width
        };
    },

    /**
     * Instant Client-Side Password Generator
     */
    generatePassword(options = {}) {
        const {
            length = 20,
            upper = true,
            lower = true,
            digits = true,
            symbols = true,
            avoidAmbiguous = true
        } = options;

        let upperChars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        let lowerChars = "abcdefghijkmnopqrstuvwxyz";
        let digitChars = "23456789";
        let symbolChars = "!@#$%^&*()_+-=[]{}|;:,.<>?";

        if (!avoidAmbiguous) {
            upperChars += "IO";
            lowerChars += "l";
            digitChars += "01";
        }

        let charPool = "";
        const guaranteed = [];

        if (upper) {
            charPool += upperChars;
            guaranteed.push(upperChars[Math.floor(Math.random() * upperChars.length)]);
        }
        if (lower) {
            charPool += lowerChars;
            guaranteed.push(lowerChars[Math.floor(Math.random() * lowerChars.length)]);
        }
        if (digits) {
            charPool += digitChars;
            guaranteed.push(digitChars[Math.floor(Math.random() * digitChars.length)]);
        }
        if (symbols) {
            charPool += symbolChars;
            guaranteed.push(symbolChars[Math.floor(Math.random() * symbolChars.length)]);
        }

        if (!charPool) {
            charPool = upperChars + lowerChars + digitChars;
        }

        const remainingLength = Math.max(0, length - guaranteed.length);
        const randomValues = new Uint32Array(remainingLength);
        window.crypto.getRandomValues(randomValues);

        const result = [...guaranteed];
        for (let i = 0; i < remainingLength; i++) {
            result.push(charPool[randomValues[i] % charPool.length]);
        }

        // Fisher-Yates cryptographically secure shuffle
        for (let i = result.length - 1; i > 0; i--) {
            const jBuffer = new Uint32Array(1);
            window.crypto.getRandomValues(jBuffer);
            const j = jBuffer[0] % (i + 1);
            [result[i], result[j]] = [result[j], result[i]];
        }

        return result.join('');
    },

    /**
     * Memorable Passphrase Generator (Diceware style)
     */
    generatePassphrase(wordCount = 4, separator = '-') {
        const words = [
            "amber", "beacon", "cipher", "delta", "echo", "falcon", "glacier", "horizon",
            "island", "jasper", "knight", "lunar", "matrix", "nexus", "orbit", "prism",
            "quantum", "radar", "shadow", "titan", "umbra", "vortex", "zenith", "aurora",
            "breeze", "cascade", "dragon", "enigma", "forest", "galaxy", "harbor", "iron",
            "jungle", "kinetic", "legacy", "meteor", "nebula", "ocean", "phoenix", "quest",
            "river", "summit", "thunder", "unity", "valley", "wizard", "xenon", "yield"
        ];

        const selected = [];
        const randoms = new Uint32Array(wordCount);
        window.crypto.getRandomValues(randoms);

        for (let i = 0; i < wordCount; i++) {
            let word = words[randoms[i] % words.length];
            if (i === 1) {
                word = word.charAt(0).toUpperCase() + word.slice(1);
            }
            selected.push(word);
        }

        const numBuf = new Uint32Array(1);
        window.crypto.getRandomValues(numBuf);
        const num = (numBuf[0] % 90) + 10;

        return selected.join(separator) + num;
    }
};

window.CryptoHelper = CryptoHelper;
