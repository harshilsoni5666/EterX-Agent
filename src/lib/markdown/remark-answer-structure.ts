import type { Nodes, Root, Table } from 'mdast';

function textContent(node: Nodes): string {
  if ('value' in node) return String(node.value);
  return 'children' in node ? node.children.map(textContent).join('') : '';
}

const EMPTY_CELL = /^(?:[-–—]|n\/?a)?$/i;
const NUMERIC_CELL = /^\(?[+−-]?\s*(?:\p{Sc}|[A-Z]{3})?\s*\d[\d,\s]*(?:\.\d+)?\s*(?:%|‰|\p{Sc}|[A-Z]{3})?\)?$/u;

function formatTable(node: Table) {
  const rows = node.children.map(row => row.children.map(cell => textContent(cell).trim()));
  const columns = rows[0]?.length || 0;
  node.align ||= Array(columns).fill(null);
  for (let column = 0; column < columns; column += 1) {
    if (node.align[column]) continue; // Authored :--- / ---: / :---: wins.
    const values = rows.slice(1).map(row => row[column] || '').filter(value => !EMPTY_CELL.test(value));
    if (values.length && values.every(value => NUMERIC_CELL.test(value))) node.align[column] = 'right';
  }
  node.children.forEach((row, rowIndex) => row.children.forEach((cell, column) => {
    if (rowIndex > 0 && NUMERIC_CELL.test(rows[rowIndex][column])) {
      cell.data ||= {};
      cell.data.hProperties = { ...cell.data.hProperties, 'data-numeric': 'true' };
    }
  }));
  node.data ||= {};
  node.data.hProperties = {
    ...node.data.hProperties,
    // Pass display data through HAST, then consume it in the table component.
    // Copying a table yields TSV suitable for spreadsheet paste, without UI
    // button labels or KaTeX's duplicate visual/MathML representations.
    'data-table-copy': rows.map(row => row.map(value => value.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n'),
    'data-table-label': rows[0]?.filter(Boolean).join(', ') || 'Data table',
  };
}

export function remarkAnswerStructure() {
  return (tree: Root) => {
    const visit = (node: Nodes) => {
      if (node.type === 'code') {
        node.data ||= {};
        node.data.hProperties = { ...node.data.hProperties, 'data-block-code': true };
      } else if (node.type === 'table') {
        formatTable(node);
      }
      if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}
