import remarkMath from 'remark-math';
import type { Nodes, Root } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Code, Construct, Extension as MicromarkExtension, State, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    eterxMath: 'eterxMath';
    eterxMathMarker: 'eterxMathMarker';
    eterxMathData: 'eterxMathData';
  }
  interface Token {
    _eterxDisplayMath?: boolean;
  }
}

// Reject ambiguous currency at the tokenizer boundary. Restoring text after
// parsing is too late: a price can otherwise consume the opening $ of a real
// equation farther along the paragraph and lose its Markdown formatting.
function isCurrencyPair(source: string, following: Code): boolean {
  if (!source.startsWith('$') || source.startsWith('$$')) return false;
  const value = source.slice(1, -1);
  if (!/^\s*[+-]?(?:\d|\.\d)/.test(value)) return false;
  if (/\\[a-zA-Z]+|[_^=<>]/.test(value)) return false;
  const followedByAmount = following !== null && following >= 48 && following <= 57;
  const amountsAndSeparators = /^[\d\s.,+\-–—/%():;*×÷]+$/.test(value);
  const proseBetweenAmounts = /\b[a-zA-Z]{2,}\b/.test(value) && /\s/.test(value);
  return (followedByAmount && (amountsAndSeparators || proseBetweenAmounts))
    || (proseBetweenAmounts && /\s$/.test(value));
}

// Parse explicit TeX delimiters as Markdown syntax, not by replacing strings.
// Code spans, fences, link destinations and escaped backslashes consequently
// retain the parser's normal protection, including while a reply is streaming.
const tokenizeTexMath: Tokenizer = function (effects, ok, nok) {
  let closing = 0;
  let hasContent = false;
  let outer: ReturnType<typeof effects.enter>;
  return start;

  function start(code: Code): State | undefined {
    outer = effects.enter('eterxMath');
    effects.enter('eterxMathMarker');
    effects.consume(code);
    return opening;
  }

  function opening(code: Code): State | undefined {
    if (code !== 40 && code !== 91) return nok(code);
    closing = code === 40 ? 41 : 93;
    outer._eterxDisplayMath = code === 91;
    effects.consume(code);
    effects.exit('eterxMathMarker');
    return between;
  }

  function between(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === 92) {
      effects.enter('eterxMathMarker');
      effects.consume(code);
      return afterBackslash;
    }
    effects.enter('eterxMathData');
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || code === 92) {
      effects.exit('eterxMathData');
      return between(code);
    }
    if (code > 0 && code !== 32) hasContent = true;
    effects.consume(code);
    return data;
  }

  function afterBackslash(code: Code): State | undefined {
    if (code === closing && hasContent) {
      effects.consume(code);
      effects.exit('eterxMathMarker');
      effects.exit('eterxMath');
      return ok;
    }
    // A TeX command or a \\ row separator belongs to the equation. Consuming
    // the next character here also prevents an escaped \\] closing the math.
    const marker = effects.exit('eterxMathMarker');
    marker.type = 'eterxMathData';
    if (code === null) return nok(code);
    effects.enter('eterxMathData');
    if (code > 0 && code !== 32) hasContent = true;
    effects.consume(code);
    return data;
  }
};

const texFromMarkdown: FromMarkdownExtension = {
  enter: {
    eterxMath(token) {
      this.enter({
        type: 'inlineMath',
        value: '',
        data: {
          hName: 'code',
          hProperties: { className: ['language-math', token._eterxDisplayMath ? 'math-display' : 'math-inline'] },
          hChildren: [],
        },
      }, token);
      this.buffer();
    },
  },
  exit: {
    eterxMathData(token) {
      this.config.enter.data.call(this, token);
      this.config.exit.data.call(this, token);
    },
    eterxMath(token) {
      const value = this.resume();
      const node = this.stack[this.stack.length - 1];
      this.exit(token);
      if (node.type === 'inlineMath') {
        node.value = value;
        node.data!.hChildren = [{ type: 'text', value }];
      }
    },
  },
};

export function remarkRichMath(this: Processor<Root>) {
  remarkMath.call(this, { singleDollarTextMath: true });
  const data = this.data() as {
    micromarkExtensions?: MicromarkExtension[];
    fromMarkdownExtensions?: FromMarkdownExtension[];
  };
  const extensions = data.micromarkExtensions!;
  const dollar = extensions[extensions.length - 1].text![36] as Construct;
  const tokenizeDollar = dollar.tokenize;
  dollar.tokenize = function (effects, ok, nok) {
    const start = this.now();
    return tokenizeDollar.call(this, effects, code => {
      const source = this.sliceSerialize({ start, end: this.now() });
      return isCurrencyPair(source, code) ? nok(code) : ok(code);
    }, nok);
  };
  extensions.push({ text: { 92: { name: 'eterxMath', tokenize: tokenizeTexMath } } });
  data.fromMarkdownExtensions!.push(texFromMarkdown);

  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value || '');
    const visit = (node: Nodes) => {
      // $$x$$ is display math even when it appears on a single line or inside
      // a list. Only explicit delimiters change presentation; never guess TeX
      // from ordinary words, bare equations, or a latex-tagged code sample.
      if (node.type === 'inlineMath') {
        const start = node.position?.start?.offset;
        if (typeof start === 'number' && source.startsWith('$$', start)) {
          node.data!.hProperties!.className = ['language-math', 'math-display'];
        }
      }
      if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}
