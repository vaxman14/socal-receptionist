// Day-by-day business hours picker with optional lunch break.
// Serializes to a human-readable string the AI prompt can understand.

import { useState, useEffect } from 'react';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const TIMES = (() => {
  const t = [];
  for (let h = 6; h <= 22; h++) {
    for (const m of [0, 30]) {
      if (h === 22 && m === 30) continue;
      const period = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 || 12;
      t.push({
        value: `${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`,
        label: `${h12}:${m === 0 ? '00' : '30'} ${period}`,
      });
    }
  }
  return t;
})();

const DEFAULT_OPEN  = '09:00';
const DEFAULT_CLOSE = '17:00';
const DEFAULT_LUNCH_START = '12:00';
const DEFAULT_LUNCH_END   = '13:00';

function toLabel(value) {
  return TIMES.find((t) => t.value === value)?.label ?? value;
}

function labelToValue(label) {
  return TIMES.find((t) => t.label.toLowerCase() === label.toLowerCase())?.value;
}

function serialize(days) {
  return days.map((d) => {
    if (!d.isOpen) return `${d.name}: Closed`;
    if (d.hasLunch) {
      return `${d.name}: ${toLabel(d.from)} – ${toLabel(d.lunchStart)}, ${toLabel(d.lunchEnd)} – ${toLabel(d.to)}`;
    }
    return `${d.name}: ${toLabel(d.from)} – ${toLabel(d.to)}`;
  }).join('\n');
}

function parse(str) {
  if (!str) return buildDefaults();
  const lines = str.split('\n').map((l) => l.trim()).filter(Boolean);
  return DAYS.map((name) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase()));
    if (!line) return { name, isOpen: true, from: DEFAULT_OPEN, to: DEFAULT_CLOSE, hasLunch: false, lunchStart: DEFAULT_LUNCH_START, lunchEnd: DEFAULT_LUNCH_END };
    if (line.toLowerCase().includes('closed'))
      return { name, isOpen: false, from: DEFAULT_OPEN, to: DEFAULT_CLOSE, hasLunch: false, lunchStart: DEFAULT_LUNCH_START, lunchEnd: DEFAULT_LUNCH_END };

    // "Day: 9:00 AM – 12:00 PM, 1:00 PM – 5:00 PM"  (lunch break)
    const lunchMatch = line.match(/:\s*(\d+:\d+\s*[AP]M)\s*[–-]\s*(\d+:\d+\s*[AP]M)\s*,\s*(\d+:\d+\s*[AP]M)\s*[–-]\s*(\d+:\d+\s*[AP]M)/i);
    if (lunchMatch) {
      return {
        name, isOpen: true, hasLunch: true,
        from:       labelToValue(lunchMatch[1].trim()) ?? DEFAULT_OPEN,
        lunchStart: labelToValue(lunchMatch[2].trim()) ?? DEFAULT_LUNCH_START,
        lunchEnd:   labelToValue(lunchMatch[3].trim()) ?? DEFAULT_LUNCH_END,
        to:         labelToValue(lunchMatch[4].trim()) ?? DEFAULT_CLOSE,
      };
    }

    // "Day: 9:00 AM – 5:00 PM"
    const simple = line.match(/:\s*(\d+:\d+\s*[AP]M)\s*[–-]\s*(\d+:\d+\s*[AP]M)/i);
    if (simple) {
      return {
        name, isOpen: true, hasLunch: false,
        from: labelToValue(simple[1].trim()) ?? DEFAULT_OPEN,
        to:   labelToValue(simple[2].trim()) ?? DEFAULT_CLOSE,
        lunchStart: DEFAULT_LUNCH_START, lunchEnd: DEFAULT_LUNCH_END,
      };
    }

    return { name, isOpen: true, from: DEFAULT_OPEN, to: DEFAULT_CLOSE, hasLunch: false, lunchStart: DEFAULT_LUNCH_START, lunchEnd: DEFAULT_LUNCH_END };
  });
}

function buildDefaults() {
  return DAYS.map((name) => ({
    name,
    isOpen: !['Saturday', 'Sunday'].includes(name),
    from: DEFAULT_OPEN,
    to: DEFAULT_CLOSE,
    hasLunch: false,
    lunchStart: DEFAULT_LUNCH_START,
    lunchEnd: DEFAULT_LUNCH_END,
  }));
}

export default function BusinessHoursPicker({ value, onChange }) {
  const [days, setDays] = useState(() => parse(value));

  useEffect(() => { setDays(parse(value)); }, [value]);

  function update(index, patch) {
    const next = days.map((d, i) => (i === index ? { ...d, ...patch } : d));
    setDays(next);
    onChange(serialize(next));
  }

  return (
    <div className="hours-picker">
      {days.map((day, i) => (
        <div key={day.name} className="hours-row">
          <label className="hours-toggle">
            <input type="checkbox" checked={day.isOpen} onChange={(e) => update(i, { isOpen: e.target.checked })} />
            <span className="hours-day">{day.name.slice(0, 3)}</span>
          </label>

          {day.isOpen ? (
            <div className="hours-open-block">
              <div className="hours-times">
                <select value={day.from} onChange={(e) => update(i, { from: e.target.value })}>
                  {TIMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <span className="hours-sep">to</span>
                <select value={day.to} onChange={(e) => update(i, { to: e.target.value })}>
                  {TIMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <label className="hours-lunch-toggle">
                  <input type="checkbox" checked={day.hasLunch} onChange={(e) => update(i, { hasLunch: e.target.checked })} />
                  <span>Lunch</span>
                </label>
              </div>

              {day.hasLunch && (
                <div className="hours-times hours-lunch-row">
                  <span className="hours-sep" style={{ minWidth: 50 }}>Break:</span>
                  <select value={day.lunchStart} onChange={(e) => update(i, { lunchStart: e.target.value })}>
                    {TIMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <span className="hours-sep">to</span>
                  <select value={day.lunchEnd} onChange={(e) => update(i, { lunchEnd: e.target.value })}>
                    {TIMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <span className="hours-closed">Closed</span>
          )}
        </div>
      ))}
    </div>
  );
}
