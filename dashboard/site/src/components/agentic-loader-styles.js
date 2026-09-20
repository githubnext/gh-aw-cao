const BAR_COUNT = 13;
const RIDER_ENTRY_PERCENT = 3.03;
const RIDER_TRAVEL_PERCENT = 24.242;
const RIDER_ACTIVE_PERCENT = 32.535;
const RIDER_FADE_PERCENT = 3.03;
/** @type {Array<[string, number]>} */
const RIDER_COLORS = [
  ['yellow', 0],
  ['pink', 33.333],
  ['blue', 66.667]
];

/**
 * @param {string} color
 * @param {number} intensity
 */
function barGradient(color, intensity) {
  const percentage = Math.round(intensity * 100);
  return `linear-gradient(180deg, color-mix(in srgb, var(--agentic-rider-${color}) ${percentage}%, var(--lime)), color-mix(in srgb, var(--agentic-rider-${color}) ${percentage}%, var(--success)))`;
}

function barColorAnimations() {
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const position = index / (BAR_COUNT - 1);
    const keyframes = RIDER_COLORS.flatMap(([color, start]) => {
      const end = start + RIDER_ACTIVE_PERCENT;
      const peak = start + RIDER_ENTRY_PERCENT + (RIDER_TRAVEL_PERCENT * position);
      const frames = [
        `${start}% { background: ${barGradient(color, 0)}; }`,
        `${(start + RIDER_FADE_PERCENT).toFixed(3)}% { background: ${barGradient(color, 1 - position)}; }`
      ];
      if (peak > start + RIDER_FADE_PERCENT && peak < end - RIDER_FADE_PERCENT) {
        frames.push(`${peak.toFixed(3)}% { background: ${barGradient(color, 1)}; }`);
      }
      frames.push(
        `${(end - RIDER_FADE_PERCENT).toFixed(3)}% { background: ${barGradient(color, Math.max(position, .2))}; }`,
        `${end.toFixed(3)}% { background: ${barGradient(color, 0)}; }`
      );
      return frames;
    });

    return `
.agentic-loader-rhythm i:nth-of-type(${index + 1})::after { animation-name: agentic-loader-bar-color-${index + 1}; }
@keyframes agentic-loader-bar-color-${index + 1} {
  ${keyframes.join('\n  ')}
}`;
  }).join('');
}

export function agenticLoaderStylesheet() {
  return `
.agentic-loader { --agentic-logo-purple: #c06eff; --agentic-rider-yellow: #d8dd57; --agentic-rider-pink: #d13ef4; --agentic-rider-blue: #58a6ff; min-height: min(42vh, 360px); position: relative; display: grid; place-items: center; overflow: hidden; visibility: hidden; border: 0; background: transparent; isolation: isolate; animation: agentic-loader-reveal 0s linear 300ms forwards; }
.agentic-loader-compact { min-height: min(34vh, 300px); }
.agentic-loader-scene { width: min(420px, calc(100vw - 64px)); max-width: calc(100% - 32px); display: flex; flex-direction: column; align-items: center; gap: 22px; }
.agentic-loader-rhythm { width: 100%; height: 72px; position: relative; display: flex; align-items: flex-end; justify-content: center; gap: 7px; }
.agentic-loader-rhythm i { width: min(16px, 4vw); height: 42px; position: relative; overflow: hidden; border-radius: 3px; background: linear-gradient(180deg, var(--lime), var(--success)); box-shadow: 0 0 5px color-mix(in srgb, var(--success) 28%, transparent); transform: scaleY(.28); transform-origin: center bottom; animation: agentic-loader-wave 6.6s ease-in-out infinite; }
.agentic-loader-rhythm i::after { content: ""; position: absolute; inset: 0; animation-duration: 19.8s; animation-timing-function: linear; animation-iteration-count: infinite; }
.agentic-loader-rhythm i:nth-of-type(1) { animation-delay: -6s; }
.agentic-loader-rhythm i:nth-of-type(2) { animation-delay: -5.6s; }
.agentic-loader-rhythm i:nth-of-type(3) { animation-delay: -5.2s; }
.agentic-loader-rhythm i:nth-of-type(4) { animation-delay: -4.8s; }
.agentic-loader-rhythm i:nth-of-type(5) { animation-delay: -4.4s; }
.agentic-loader-rhythm i:nth-of-type(6) { animation-delay: -4s; }
.agentic-loader-rhythm i:nth-of-type(7) { animation-delay: -3.6s; }
.agentic-loader-rhythm i:nth-of-type(8) { animation-delay: -3.2s; }
.agentic-loader-rhythm i:nth-of-type(9) { animation-delay: -2.8s; }
.agentic-loader-rhythm i:nth-of-type(10) { animation-delay: -2.4s; }
.agentic-loader-rhythm i:nth-of-type(11) { animation-delay: -2s; }
.agentic-loader-rhythm i:nth-of-type(12) { animation-delay: -1.6s; }
.agentic-loader-rhythm i:nth-of-type(13) { animation-delay: -1.2s; }
.agentic-loader-riders { position: absolute; z-index: 2; inset: 0 0 12px; overflow: visible; pointer-events: none; }
.agentic-loader-rider { width: 36px; height: 30px; position: absolute; top: 0; left: 0; display: grid; place-items: center; color: var(--agentic-logo-purple); filter: drop-shadow(0 0 3px color-mix(in srgb, currentColor 32%, transparent)); opacity: 0; offset-position: 0 0; offset-anchor: center; offset-path: path("M 58 16 L 362 16"); offset-rotate: auto; animation: agentic-loader-rider-cruise 19.8s linear infinite; }
.agentic-loader-rider-duck { color: var(--yellow); offset-path: path("M 20 40 L 428 40"); animation-delay: 0s; }
.agentic-loader-rider-octocat { color: var(--agentic-logo-purple); offset-path: path("M 20 40 L 428 40"); animation-delay: -13.2s; }
.agentic-loader-rider-copilot { color: var(--accent); offset-path: path("M 20 40 L 428 40"); animation-delay: -6.6s; }
.agentic-loader-rider-icon { width: 36px; height: 30px; overflow: visible; }
.agentic-loader-caption { display: inline-flex; min-height: 38px; flex-direction: column; align-items: center; gap: 1px; color: var(--fgColor-default, #f0f6fc); text-align: center; }
.agentic-loader-caption-eyebrow { color: var(--fgColor-muted, #8b949e); font-size: 10px; font-weight: 600; line-height: 14px; letter-spacing: .12em; text-transform: uppercase; }
.agentic-loader-caption-status { display: inline-flex; align-items: baseline; font-size: 13px; font-weight: 600; line-height: 20px; }
.agentic-loader-caption-dots { display: inline-flex; align-items: center; gap: 3px; margin-left: 5px; }
.agentic-loader-caption-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--fgColor-default, #f0f6fc); opacity: .3; animation: agentic-loader-caption-dot 1.2s ease-in-out infinite; }
.agentic-loader-caption-dot:nth-child(2) { animation-delay: .15s; }
.agentic-loader-caption-dot:nth-child(3) { animation-delay: .3s; }
.factory-floor:has(> .agentic-loader-factory-overlay) > .factory-stations { visibility: hidden; }
.agentic-loader-factory-overlay { min-height: 0; position: absolute; z-index: 2; inset: 0; pointer-events: none; }
@keyframes agentic-loader-wave {
  0%, 100% { opacity: .5; transform: scaleY(.28); }
  50% { opacity: .9; transform: scaleY(.82); }
}
@keyframes agentic-loader-reveal {
  to { visibility: visible; }
}
@keyframes agentic-loader-rider-cruise {
  0% { opacity: 0; offset-distance: 0%; }
  3.03% { opacity: 1; offset-distance: 9.314%; }
  29.505% { opacity: 1; offset-distance: 90.686%; }
  32.535% { opacity: 0; offset-distance: 100%; }
  100% { opacity: 0; offset-distance: 100%; }
}
@keyframes agentic-loader-caption-dot {
  0%, 60%, 100% { opacity: .28; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-1px); }
}
@media (max-width: 700px) {
  .agentic-loader-scene { width: min(360px, calc(100vw - 40px)); }
  .agentic-loader-rhythm { gap: 5px; }
  .agentic-loader-rider-duck, .agentic-loader-rider-octocat, .agentic-loader-rider-copilot { offset-path: path("M 28 40 L 348 40"); }
}
@media (prefers-reduced-motion: reduce) {
  .agentic-loader { visibility: visible; animation: none; }
  .agentic-loader-rhythm i, .agentic-loader-rhythm i::after, .agentic-loader-rider, .agentic-loader-caption-dot { animation: none; }
  .agentic-loader-rider { display: none; }
}
${barColorAnimations()}`;
}
