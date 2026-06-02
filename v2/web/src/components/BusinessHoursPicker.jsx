// Day-by-day business hours picker.
// Stores as a human-readable multiline string compatible with the AI prompt.

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

const DEFAULT_OPEN = '09:00';
const DEFAULT_CLOSE = '17:00';

function serialize(days) {
  return days
    .map((d) =>
      d.isOpen
        ? `${d.name}: ${toLabel(d.from)} – ${toLabel(d.to)}`
        : `${d.name}: Closed`
    )
    .join('\n');
}

function toLabel(value) {
  const t = TIMES.find((t) => t.value === value);
  return t ? t.label : value;
}

function parse(str) {
  if (!str) return buildDefaults();
  const lines = str.split('\n').map((l) => l.trim()).filter(Boolean);
  return DAYS.map((name) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase()));
    if (!line) return { name, isOpen: true, from: DEFAULT_OPEN, to: DEFAULT_CLOSE };
    if (line.toLowerCase().includes('closed'))
      return { name, isOpen: false, from: DEFAULT_OPEN, to: DEFAULT_CLOSE };
    // try to parse "Day: H:MM AM – H:MM PM"
    const match = line.match(/:\s*(\d+:\d+\s*[AP]M)\s*[–-]\s*(\d+:\d+\s*[AP]M)/i);
    if (match) {
      const from = labelToValue(match[1].trim()) || DEFAULT_OPEN;
      const to   = labelToValue(match[2].trim()) || DEFAULT_CLOSE;
      return { name, isOpen: true, from, to };
    }
    return { name, isOpen: true, from: DEFAULT_OPEN, to: DEFAULT_CLOSE };
  });
}

function labelToValue(label) {
  const t = TIMES.find((t) => t.label.toLowerCase() === label.toLowerCase());
  return t?.value;
}

function buildDefaults() {
  return DAYS.map((name) => ({
    name,
    isOpen: !['Saturday', 'Sunday'].includes(name),
    from: DEFAULT_OPEN,
    to: DEFAULT_CLOSE,
  }));
}

export default function BusinessHoursPicker({ value, onChange }) {
  const [days, setDays] = useState(() => parse(value));

  // Sync inbound value changes (e.g. initial load from API).
  useEffect(() => {
    setDays(parse(value));
  }, [value]);

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
            <input
              type="checkbox"
              checked={day.isOpen}
              onChange={(e) => update(i, { isOpen: e.target.checked })}
            />
            <span className="hours-day">{day.name.slice(0, 3)}</span>
          </label>

          {day.isOpen ? (
            <div className="hours-times">
              <select
                value={day.from}
                onChange={(e) => update(i, { from: e.target.value })}
              >
                {TIMES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <span className="hours-sep">to</span>
              <select
                value={day.to}
                onChange={(e) => update(i, { to: e.target.value })}
              >
                {TIMES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <span className="hours-closed">Closed</span>
          )}
        </div>
      ))}
    </div>
  );
}
