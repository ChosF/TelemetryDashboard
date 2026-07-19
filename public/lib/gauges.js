/**
 * Lightweight Canvas-based Gauges
 * High-performance replacement for ECharts gauges
 */

class CanvasGauge {
    constructor(container, options = {}) {
        this.container = typeof container === 'string' ? document.getElementById(container) : container;
        this.options = {
            min: options.min ?? 0,
            max: options.max ?? 100,
            value: options.value ?? 0,
            title: options.title ?? '',
            unit: options.unit ?? '',
            decimals: options.decimals ?? 1,
            color: options.color ?? '#00d4ff',
            bgColor: options.bgColor ?? 'rgba(255,255,255,0.1)',
            textColor: options.textColor ?? '#ffffff',
            animate: options.animate ?? false,
            arcWidth: options.arcWidth ?? 0.15, // Fraction of radius
            startAngle: options.startAngle ?? 0.75 * Math.PI,
            endAngle: options.endAngle ?? 2.25 * Math.PI
        };

        this.currentValue = this.options.value;
        this.targetValue = this.options.value;
        this.animationFrame = null;

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.ctx = this.canvas.getContext('2d');
        this.container.appendChild(this.canvas);

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.width = rect.width;
        this.height = rect.height;
        this.render();
    }

    setValue(value, animate = false) {
        const newValue = Math.max(this.options.min, Math.min(this.options.max, value));
        if (Math.abs(newValue - this.currentValue) < 0.001) return;

        this.targetValue = newValue;

        if (animate && this.options.animate) {
            this.animateToValue();
        } else {
            this.currentValue = newValue;
            this.render();
        }
    }

    animateToValue() {
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);

        const animate = () => {
            const diff = this.targetValue - this.currentValue;
            if (Math.abs(diff) < 0.01) {
                this.currentValue = this.targetValue;
                this.render();
                return;
            }
            this.currentValue += diff * 0.15;
            this.render();
            this.animationFrame = requestAnimationFrame(animate);
        };
        animate();
    }

    render() {
        const { ctx, width, height, options } = this;
        const { min, max, startAngle, endAngle, color, bgColor, textColor, arcWidth, decimals, unit } = options;

        ctx.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(cx, cy) * 0.85;
        const lineWidth = radius * arcWidth;

        // Background arc
        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.strokeStyle = bgColor;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Value arc
        const range = max - min;
        const pct = range > 0 ? (this.currentValue - min) / range : 0;
        const valueAngle = startAngle + pct * (endAngle - startAngle);

        if (pct > 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, radius, startAngle, valueAngle);

            // Gradient
            const gradient = ctx.createLinearGradient(cx - radius, cy, cx + radius, cy);
            gradient.addColorStop(0, color);
            gradient.addColorStop(1, this.adjustColor(color, 30));
            ctx.strokeStyle = gradient;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        // Center value text
        const valueText = this.currentValue.toFixed(decimals);
        ctx.fillStyle = textColor;
        ctx.font = `bold ${radius * 0.4}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(valueText, cx, cy - radius * 0.05);

        // Unit text
        if (unit) {
            ctx.font = `${radius * 0.18}px Inter, system-ui, sans-serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText(unit, cx, cy + radius * 0.25);
        }
    }

    adjustColor(hex, percent) {
        const num = parseInt(hex.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, (num >> 16) + amt);
        const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
        const B = Math.min(255, (num & 0x0000FF) + amt);
        return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
    }

    destroy() {
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        window.removeEventListener('resize', this.resize);
        this.canvas.remove();
    }
}

// G-Force scatter gauge (special case)
class GForceGauge {
    constructor(container, options = {}) {
        this.container = typeof container === 'string' ? document.getElementById(container) : container;
        this.options = {
            maxG: options.maxG ?? 2,
            color: options.color ?? '#00d4ff',
            bgColor: options.bgColor ?? 'rgba(255,255,255,0.1)',
            textColor: options.textColor ?? '#ffffff'
        };

        this.gLat = 0;
        this.gLong = 0;
        this.history = [];
        this.maxHistory = 50;

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.ctx = this.canvas.getContext('2d');
        this.container.appendChild(this.canvas);

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.width = rect.width;
        this.height = rect.height;
        this.render();
    }

    setValues(gLat, gLong) {
        this.gLat = gLat;
        this.gLong = gLong;
        this.history.push({ lat: gLat, long: gLong });
        if (this.history.length > this.maxHistory) this.history.shift();
        this.render();
    }

    render() {
        const { ctx, width, height, options } = this;
        const { maxG, color, bgColor } = options;

        ctx.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(cx, cy) * 0.85;
        const scale = radius / maxG;

        // Background circles
        ctx.strokeStyle = bgColor;
        ctx.lineWidth = 1;
        for (let g = 0.5; g <= maxG; g += 0.5) {
            ctx.beginPath();
            ctx.arc(cx, cy, g * scale, 0, 2 * Math.PI);
            ctx.stroke();
        }

        // Crosshairs
        ctx.beginPath();
        ctx.moveTo(cx - radius, cy);
        ctx.lineTo(cx + radius, cy);
        ctx.moveTo(cx, cy - radius);
        ctx.lineTo(cx, cy + radius);
        ctx.stroke();

        // History trail
        ctx.globalAlpha = 0.3;
        for (let i = 0; i < this.history.length - 1; i++) {
            const p = this.history[i];
            const x = cx + p.lat * scale;
            const y = cy - p.long * scale;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // Current position
        const x = cx + this.gLat * scale;
        const y = cy - this.gLong * scale;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();

        // Total G text
        const totalG = Math.sqrt(this.gLat ** 2 + this.gLong ** 2);
        ctx.fillStyle = options.textColor;
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${totalG.toFixed(2)} G`, cx, height - 8);
    }

    destroy() {
        window.removeEventListener('resize', this.resize);
        this.canvas.remove();
    }
}

window.CanvasGauge = CanvasGauge;
window.GForceGauge = GForceGauge;
