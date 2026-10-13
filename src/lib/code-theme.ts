import type { ThemeRegistration } from 'shiki';

// Shared by the workspace highlighter, editable files, and Markdown code blocks.
export const codePalettes = {
  dark: {
    background: '#111111', foreground: '#F0F0F0', comment: '#929AA6',
    string: '#9AE66E', number: '#78C8FF', keyword: '#FF6B80',
    declaration: '#E7D8FF', type: '#FFD178', function: '#C792FF',
    variable: '#FFB454', property: '#52DAFF', punctuation: '#AAB2BF',
    added: '#00D26A', removed: '#FF514D', addedBackground: '#1B301E',
    removedBackground: '#3B1D1B', addedGutter: '#122518', removedGutter: '#301513',
    addedWord: '#286D3880', removedWord: '#AF383C70',
    lineNumber: '#929292', selection: '#3E597B80', surface: '#222222', border: '#363636',
  },
  light: {
    background: '#FFFFFF', foreground: '#24292F', comment: '#68717E',
    string: '#187238', number: '#075DB3', keyword: '#C42B49',
    declaration: '#7536AF', type: '#925300', function: '#7638BF',
    variable: '#914B12', property: '#006C91', punctuation: '#58616E',
    added: '#087536', removed: '#CB302B', addedBackground: '#E4F4E6',
    removedBackground: '#FCE8E6', addedGutter: '#CDEACF', removedGutter: '#F7D4D0',
    addedWord: '#A8DDB2', removedWord: '#F5B9B3',
    lineNumber: '#69727E', selection: '#BBD7F5', surface: '#F3F4F5', border: '#D9DDE2',
  },
};

function createShikiTheme(mode: keyof typeof codePalettes): ThemeRegistration {
  const c = codePalettes[mode];
  return {
    name: `eterx-${mode}`, type: mode,
    colors: { 'editor.background': c.background, 'editor.foreground': c.foreground },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment } },
      { scope: ['string', 'markup.inline.raw'], settings: { foreground: c.string } },
      { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: c.number } },
      { scope: ['keyword', 'storage.modifier'], settings: { foreground: c.keyword } },
      { scope: ['storage.type', 'keyword.declaration'], settings: { foreground: c.declaration } },
      { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: c.type } },
      { scope: ['entity.name.function', 'support.function'], settings: { foreground: c.function } },
      { scope: ['variable', 'meta.definition.variable', 'support.variable'], settings: { foreground: c.variable } },
      { scope: ['variable.other.property', 'support.type.property-name', 'entity.other.attribute-name', 'entity.name.tag', 'entity.other.attribute-name.class.css', 'entity.other.attribute-name.id.css'], settings: { foreground: c.property } },
      { scope: ['punctuation', 'keyword.operator'], settings: { foreground: c.punctuation } },
      { scope: ['punctuation.definition.string', 'constant.other.color'], settings: { foreground: c.string } },
      { scope: ['markup.heading'], settings: { foreground: c.property, fontStyle: 'bold' } },
      { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
      { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
      { scope: ['markup.inserted'], settings: { foreground: c.added } },
      { scope: ['markup.deleted'], settings: { foreground: c.removed } },
    ],
  };
}

export const workspaceCodeThemes = [createShikiTheme('light'), createShikiTheme('dark')];

export function createMonacoCodeTheme(mode: keyof typeof codePalettes) {
  const c = codePalettes[mode];
  const tokenColors: Record<string, string> = {
    '': c.foreground, comment: c.comment, string: c.string, number: c.number,
    keyword: c.keyword, 'keyword.control': c.keyword, 'keyword.declaration': c.declaration,
    type: c.type, 'type.identifier': c.type, class: c.type, 'class.identifier': c.type,
    function: c.function, 'function.call': c.function, identifier: c.variable,
    variable: c.variable, constant: c.number, operator: c.punctuation, delimiter: c.punctuation,
    tag: c.property, 'attribute.name': c.property, 'attribute.value': c.string, regexp: c.string,
  };
  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs', inherit: true,
    rules: Object.entries(tokenColors).map(([token, color]) => ({ token, foreground: color.slice(1) })),
    colors: {
      'editor.background': c.background, 'editor.foreground': c.foreground,
      'editorLineNumber.foreground': c.lineNumber, 'editorLineNumber.activeForeground': c.foreground,
      'editorGutter.background': c.background, 'editor.selectionBackground': c.selection,
      'editor.inactiveSelectionBackground': c.selection, 'editor.lineHighlightBackground': c.surface,
      'editorCursor.foreground': c.foreground, 'editorIndentGuide.background1': c.border,
      'editorIndentGuide.activeBackground1': c.lineNumber, 'editorOverviewRuler.border': c.border,
      'scrollbarSlider.background': `${c.lineNumber}55`, 'scrollbarSlider.hoverBackground': `${c.lineNumber}88`,
      'scrollbarSlider.activeBackground': `${c.lineNumber}AA`,
      'diffEditor.insertedTextBackground': '#00000000', 'diffEditor.removedTextBackground': '#00000000',
      'diffEditor.insertedTextBorder': '#00000000', 'diffEditor.removedTextBorder': '#00000000',
      'diffEditor.insertedLineBackground': c.addedBackground, 'diffEditor.removedLineBackground': c.removedBackground,
      'diffEditorGutter.insertedLineBackground': c.addedGutter, 'diffEditorGutter.removedLineBackground': c.removedGutter,
      'editorGutter.addedBackground': c.added, 'editorGutter.deletedBackground': c.removed,
      'diffEditorOverview.insertedForeground': c.added, 'diffEditorOverview.removedForeground': c.removed,
      'diffEditor.unchangedRegionBackground': c.surface, 'diffEditor.unchangedRegionForeground': c.lineNumber,
    },
  };
}

export function createPrismCodeTheme(mode: keyof typeof codePalettes) {
  const c = codePalettes[mode];
  return {
    'code[class*="language-"]': { color: c.foreground, background: 'none', textShadow: 'none' },
    'pre[class*="language-"]': { color: c.foreground, background: c.background, textShadow: 'none' },
    comment: { color: c.comment }, prolog: { color: c.comment }, doctype: { color: c.comment }, cdata: { color: c.comment },
    punctuation: { color: c.punctuation }, operator: { color: c.punctuation },
    property: { color: c.property }, tag: { color: c.property }, selector: { color: c.property },
    'attr-name': { color: c.property }, 'attr-value': { color: c.string },
    string: { color: c.string }, char: { color: c.string }, regex: { color: c.string },
    number: { color: c.number }, boolean: { color: c.number }, constant: { color: c.number }, symbol: { color: c.number },
    keyword: { color: c.keyword }, atrule: { color: c.keyword },
    function: { color: c.function }, 'function-variable': { color: c.function },
    'class-name': { color: c.type }, builtin: { color: c.type }, variable: { color: c.variable },
    parameter: { color: c.variable }, entity: { color: c.property }, url: { color: c.property },
    inserted: { color: c.added, background: c.addedBackground }, deleted: { color: c.removed, background: c.removedBackground },
    important: { color: c.keyword, fontWeight: 'bold' }, bold: { fontWeight: 'bold' }, italic: { fontStyle: 'italic' },
  };
}
