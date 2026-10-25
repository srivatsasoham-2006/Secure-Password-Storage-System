/**
 * SentinelVault - Industrial Web Audio API Procedural Sound Synthesizer
 * High-performance, zero-external-dependency, customizable micro-sound engine.
 */
class SoundEngine {
    constructor() {
        this.ctx = null;
        this.enabled = localStorage.getItem('sentinel_sound_enabled') !== 'false';
        this.volume = parseFloat(localStorage.getItem('sentinel_sound_volume') || '0.35');
        this.initialized = false;

        // Auto-initialize on first user interaction
        const unlockAudio = () => {
            this.init();
            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('keydown', unlockAudio);
        };
        document.addEventListener('click', unlockAudio, { once: true });
        document.addEventListener('keydown', unlockAudio, { once: true });
    }

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                this.ctx = new AudioCtx();
            }
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
        this.initialized = true;
    }

    setMuted(muted) {
        this.enabled = !muted;
        localStorage.setItem('sentinel_sound_enabled', this.enabled ? 'true' : 'false');
        if (this.enabled) {
            this.play('click');
        }
    }

    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, parseFloat(vol)));
        localStorage.setItem('sentinel_sound_volume', this.volume.toString());
    }

    createMasterGain() {
        if (!this.ctx) return null;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
        gain.connect(this.ctx.destination);
        return gain;
    }

    play(soundName) {
        if (!this.enabled) return;
        this.init();
        if (!this.ctx) return;

        try {
            switch (soundName) {
                case 'click':
                    this.playClick();
                    break;
                case 'hover':
                    this.playHover();
                    break;
                case 'unlock':
                    this.playUnlockChime();
                    break;
                case 'lock':
                    this.playLockSound();
                    break;
                case 'copy':
                    this.playCopySnap();
                    break;
                case 'success':
                    this.playSuccessChord();
                    break;
                case 'warning':
                case 'danger':
                    this.playWarningPulse();
                    break;
                case 'generate':
                    this.playGenerateTumbler();
                    break;
                case 'tab':
                    this.playTabChirp();
                    break;
                case 'toggle':
                    this.playToggleClick();
                    break;
                default:
                    this.playClick();
                    break;
            }
        } catch (e) {
            console.warn('Audio playback glitch:', e);
        }
    }

    // --- Procedural Sound Generators ---

    /** Crisp tactile mechanical micro-click */
    playClick() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, now);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.04);

        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

        osc.connect(gain);
        gain.connect(master);

        osc.start(now);
        osc.stop(now + 0.045);
    }

    /** Subtle switch toggle */
    playToggleClick() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(900, now);
        osc.frequency.exponentialRampToValueAtTime(450, now + 0.05);

        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

        osc.connect(gain);
        gain.connect(master);

        osc.start(now);
        osc.stop(now + 0.055);
    }

    /** Ultra-light subtle hover micro-pip */
    playHover() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);

        osc.connect(gain);
        gain.connect(master);

        osc.start(now);
        osc.stop(now + 0.025);
    }

    /** Double-tick snap on clipboard copy */
    playCopySnap() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        // Tick 1
        const osc1 = this.ctx.createOscillator();
        const gain1 = this.ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1800, now);
        osc1.frequency.exponentialRampToValueAtTime(600, now + 0.03);
        gain1.gain.setValueAtTime(0.4, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
        osc1.connect(gain1);
        gain1.connect(master);
        osc1.start(now);
        osc1.stop(now + 0.035);

        // Tick 2 (higher pitch slightly delayed)
        const osc2 = this.ctx.createOscillator();
        const gain2 = this.ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(2400, now + 0.04);
        osc2.frequency.exponentialRampToValueAtTime(1100, now + 0.08);
        gain2.gain.setValueAtTime(0.35, now + 0.04);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc2.connect(gain2);
        gain2.connect(master);
        osc2.start(now + 0.04);
        osc2.stop(now + 0.085);
    }

    /** Smooth, pleasant vault unlock chime (Major triad chord arpeggio) */
    playUnlockChime() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
        notes.forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const startTime = now + idx * 0.07;
            const duration = 0.45;

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, startTime);

            gain.gain.setValueAtTime(0.001, startTime);
            gain.gain.linearRampToValueAtTime(0.28 / (idx + 1), startTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

            osc.connect(gain);
            gain.connect(master);

            osc.start(startTime);
            osc.stop(startTime + duration);
        });
    }

    /** Hydraulic lock latch sound */
    playLockSound() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const filter = this.ctx.createBiquadFilter();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.18);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(700, now);
        filter.frequency.exponentialRampToValueAtTime(150, now + 0.18);

        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(master);

        osc.start(now);
        osc.stop(now + 0.22);
    }

    /** Harmonious success confirmation chime */
    playSuccessChord() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const freqs = [659.25, 830.61, 987.77]; // E5, G#5, B5 (E Major)
        freqs.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const start = now + (i * 0.04);
            const duration = 0.4;

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, start);

            gain.gain.setValueAtTime(0.001, start);
            gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

            osc.connect(gain);
            gain.connect(master);

            osc.start(start);
            osc.stop(start + duration);
        });
    }

    /** Gentle two-tone warning pulse */
    playWarningPulse() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const tones = [440, 370];
        tones.forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const start = now + (idx * 0.12);

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, start);

            gain.gain.setValueAtTime(0.2, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.1);

            osc.connect(gain);
            gain.connect(master);

            osc.start(start);
            osc.stop(start + 0.12);
        });
    }

    /** High-tech tumbler shuffle sound during password generation */
    playGenerateTumbler() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const ticks = 6;
        for (let i = 0; i < ticks; i++) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const tickTime = now + (i * 0.025);

            osc.type = 'square';
            osc.frequency.setValueAtTime(900 + (i * 120), tickTime);

            gain.gain.setValueAtTime(0.12, tickTime);
            gain.gain.exponentialRampToValueAtTime(0.001, tickTime + 0.015);

            osc.connect(gain);
            gain.connect(master);

            osc.start(tickTime);
            osc.stop(tickTime + 0.02);
        }
    }

    /** Subtle navigation tab chirp */
    playTabChirp() {
        const master = this.createMasterGain();
        if (!master) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(1100, now + 0.03);

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

        osc.connect(gain);
        gain.connect(master);

        osc.start(now);
        osc.stop(now + 0.035);
    }
}

// Global instance
window.soundEngine = new SoundEngine();

// Automatic event delegation for interactive elements with data-sound
document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-sound]');
    if (target) {
        const soundType = target.getAttribute('data-sound') || 'click';
        window.soundEngine.play(soundType);
    }
});
