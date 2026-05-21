// SMS / call transcript renderer — shared by client + owner views.

import { formatDate } from '../lib/format';
import { titleCase } from '../lib/format';

export function Transcript({ messages }) {
  if (!messages || messages.length === 0) {
    return <div className="state">No messages in this conversation.</div>;
  }
  return (
    <div className="transcript">
      {messages.map((m) => (
        <div key={m.id} className={`bubble ${m.direction}`}>
          <span className="role">{titleCase(m.role || m.direction)}</span>
          {m.body}
          <span className="time">{formatDate(m.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
