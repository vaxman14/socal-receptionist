// Floating accessibility widget — text size, high contrast, reduce motion,
// dyslexia-friendly font. Settings persist in localStorage and apply to the
// document root so they affect every page. Mounted in the app shell.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'scr.a11y';
const STEPS = [90, 100, 110, 125, 140]; // font-size %

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function apply(s) {
  const root = document.documentElement;
  root.style.fontSize = `${s.fontPct || 100}%`;
  root.classList.toggle('a11y-contrast', !!s.contrast);
  root.classList.toggle('a11y-reduce-motion', !!s.reduceMotion);
  root.classList.toggle('a11y-dyslexia', !!s.dyslexia);
}

export default function AccessibilityWidget() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(load);

  // Apply on mount + whenever settings change, and persist.
  useEffect(() => {
    apply(settings);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  const fontPct = settings.fontPct || 100;
  const idx = Math.max(0, STEPS.indexOf(fontPct));
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const bumpFont = (dir) => {
    const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, idx + dir))];
    set({ fontPct: next });
  };
  const reset = () => setSettings({});

  return (
    <div className="a11y-widget">
      {open && (
        <div className="a11y-panel" role="dialog" aria-label="Accessibility options">
          <div className="a11y-panel-title">Accessibility</div>

          <div className="a11y-row">
            <span>Text size</span>
            <div className="a11y-btns">
              <button type="button" onClick={() => bumpFont(-1)} aria-label="Decrease text size" disabled={idx === 0}>A−</button>
              <span className="a11y-val">{fontPct}%</span>
              <button type="button" onClick={() => bumpFont(1)} aria-label="Increase text size" disabled={idx === STEPS.length - 1}>A+</button>
            </div>
          </div>

          <button type="button" className={`a11y-toggle ${settings.contrast ? 'on' : ''}`} onClick={() => set({ contrast: !settings.contrast })}>
            High contrast <span>{settings.contrast ? 'On' : 'Off'}</span>
          </button>
          <button type="button" className={`a11y-toggle ${settings.reduceMotion ? 'on' : ''}`} onClick={() => set({ reduceMotion: !settings.reduceMotion })}>
            Reduce motion <span>{settings.reduceMotion ? 'On' : 'Off'}</span>
          </button>
          <button type="button" className={`a11y-toggle ${settings.dyslexia ? 'on' : ''}`} onClick={() => set({ dyslexia: !settings.dyslexia })}>
            Dyslexia-friendly font <span>{settings.dyslexia ? 'On' : 'Off'}</span>
          </button>

          <button type="button" className="a11y-reset" onClick={reset}>Reset all</button>
        </div>
      )}
      <button
        type="button"
        className="a11y-fab"
        aria-label="Accessibility options"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ♿
      </button>
    </div>
  );
}
