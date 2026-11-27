import type { Nodes, Root } from 'mdast';
import { ANSWER_DETAILS_MARKER, ANSWER_VISUAL_LANGUAGE } from './answer-visual';

function textContent(node: Nodes): string {
  if ('value' in node) return String(node.value);
  return 'children' in node ? node.children.map(textContent).join('') : '';
}

export function remarkReplyStructure() {
  return (tree: Root, file: { value?: unknown }) => {
    const source = String(file.value || '');
    const visit = (node: Nodes) => {
      if (node.type === 'code' && node.lang?.toLowerCase() === ANSWER_VISUAL_LANGUAGE) {
        node.data ||= {};
        node.data.hProperties = { ...node.data.hProperties, 'data-answer-visual': true };
      } else if (node.type === 'blockquote') {
        const [summary, ...body] = node.children;
        const start = summary?.position?.start;
        // The summary occupies one paragraph. Requiring the literal marker
        // in source also keeps escaped markers and links as ordinary quotes.
        if (summary?.type === 'paragraph' && body.length && start?.offset !== undefined
          && start.line === summary.position?.end.line
          && source.startsWith(`${ANSWER_DETAILS_MARKER} `, start.offset)) {
          const label = textContent(summary).slice(ANSWER_DETAILS_MARKER.length).trim();
          if (label && label.length <= 120) {
            node.data ||= {};
            node.data.hProperties = { ...node.data.hProperties, 'data-answer-details': label };
            node.children = body;
          }
        }
      }
      if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}
