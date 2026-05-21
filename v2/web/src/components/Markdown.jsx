// Renders a Markdown string into the .doc-body container.

import { renderMarkdown } from '../lib/markdown';

export function Markdown({ source, className = 'doc-body' }) {
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
}
