import { formatReply } from '@/lib/assistant/formatReply';

/**
 * An assistant reply, laid out as headings, lists and paragraphs.
 *
 * Every block is a plain string rendered as a React text child — the reply is
 * model output, so it is never parsed as HTML and never reaches
 * dangerouslySetInnerHTML. Margins and padding are set explicitly because the
 * portal has no CSS reset: a bare <ul> would bring the browser's 40px indent
 * and 1em margins into a phone-width bubble.
 */
export function ReplyBody({ text }: { text: string }) {
  const blocks = formatReply(text);
  if (blocks.length === 0) return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{text}</p>;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <h3
              key={index}
              style={{
                margin: index === 0 ? 0 : '4px 0 0',
                padding: 0,
                fontSize: 14.5,
                fontWeight: 700,
                lineHeight: 1.4,
                color: 'var(--p-ink)',
              }}
            >
              {block.text}
            </h3>
          );
        }

        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={index} style={{ margin: 0, padding: '0 0 0 20px' }}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} style={{ margin: '2px 0', padding: 0 }}>
                  {item}
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={index} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
