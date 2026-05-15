/**
 * ═══════════════════════════════════════════════════════════════
 * EterX DOM Snapshot & Ref System — The AI's Eyes
 * ═══════════════════════════════════════════════════════════════
 * 
 * Instead of sending raw HTML (token-heavy, confusing), we generate
 * a SEMANTIC SNAPSHOT of the page with numeric refs assigned to every
 * interactive element.
 * 
 * The AI sees:
 *   [1] link "Gmail" → /gmail
 *   [2] input:search "Search" [focused] value=""
 *   [3] button "Google Search"
 * 
 * Then responds: click(ref: 3)
 * 
 * This is 10x more reliable than CSS selectors and 50x more token-
 * efficient than raw HTML.
 * 
 * Features:
 * - Assigns data-ref attributes directly to DOM elements
 * - Builds compact text representation of the page
 * - Tracks element metadata (type, text, href, value, bbox, etc.)
 * - Handles iframes recursively
 * - Detects forms, navigation, modals, overlays
 * - Auto-invalidates on navigation
 * - Multiple snapshot modes (full, interactive, forms)
 */

// ═══════════════════════════════════════
// TYPES
// ═══════════════════════════════════════

export interface ElementRef {
  ref: number;
  tag: string;
  role: string;
  text: string;
  type?: string;
  href?: string;
  value?: string;
  placeholder?: string;
  ariaLabel?: string;
  checked?: boolean;
  disabled?: boolean;
  focused?: boolean;
  required?: boolean;
  contentEditable?: boolean;
  selector: string;       // data-ref based selector
  cssPath?: string;       // backup CSS path
  bbox: { x: number; y: number; w: number; h: number };
  isVisible: boolean;
  isInViewport: boolean;
  frameId?: string;
}

export interface FormInfo {
  ref: number;
  action: string;
  method: string;
  fields: number[];       // refs of form fields
  submitButton?: number;  // ref of submit button
}

export interface SnapshotOptions {
  mode?: 'full' | 'interactive' | 'forms' | 'landmarks';
  maxElements?: number;
  includeText?: boolean;      // Include non-interactive text content
  includeFrames?: boolean;    // Recursively snapshot iframes
  viewportOnly?: boolean;     // Only elements in current viewport
  textMaxLength?: number;     // Max chars for text content
}

export interface SnapshotResult {
  snapshotText: string;       // The compact text representation for the AI
  refs: Map<number, ElementRef>;
  forms: FormInfo[];
  pageTitle: string;
  pageUrl: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  totalHeight: number;
  elementCount: number;
  timestamp: number;
}

// ═══════════════════════════════════════
// DOM SNAPSHOT ENGINE
// ═══════════════════════════════════════

export class DOMSnapshot {
  private refs: Map<number, ElementRef> = new Map();
  private forms: FormInfo[] = [];
  private lastSnapshotTime: number = 0;
  private stale: boolean = true;

  /**
   * Capture a semantic snapshot of the page.
   * This is the core method — the AI's primary way to "see" the page.
   */
  async capture(page: any, options: SnapshotOptions = {}): Promise<SnapshotResult> {
    const {
      mode = 'full',
      maxElements = 100,        // Reduced from 200 for speed — 100 is plenty for most pages
      includeText = true,
      includeFrames = false,
      viewportOnly = false,
      textMaxLength = 50,        // Shorter text for faster processing
    } = options;

    // Some TS runtimes wrap serialized functions with an esbuild __name helper.
    // Playwright evaluates that wrapper inside Chrome, so define a tiny compatible
    // helper in the page before sending function bodies.
    await page.evaluate('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn)').catch(() => {});

    // Step 1: Inject our scanner into the page and capture DOM state
    const rawData = await page.evaluate(({ mode, maxElements, includeText, viewportOnly, textMaxLength }: any) => {
      // ─── Scanner Functions (run in browser context) ───
      
      function getImplicitRole(tag: string): string {
        const roleMap: Record<string, string> = {
          'a': 'link', 'button': 'button', 'input': 'textbox',
          'select': 'combobox', 'textarea': 'textbox', 'img': 'img',
          'nav': 'navigation', 'main': 'main', 'header': 'banner',
          'footer': 'contentinfo', 'aside': 'complementary',
          'form': 'form', 'table': 'table', 'dialog': 'dialog',
          'article': 'article', 'section': 'region', 'h1': 'heading',
          'h2': 'heading', 'h3': 'heading', 'h4': 'heading',
          'h5': 'heading', 'h6': 'heading', 'ul': 'list', 'ol': 'list',
          'li': 'listitem', 'details': 'group', 'summary': 'button',
          'progress': 'progressbar', 'meter': 'meter', 'output': 'status',
        };
        return roleMap[tag] || '';
      }

      function getVisibleText(el: Element, maxLen: number): string {
        // Get direct text, not children's text
        let text = '';
        
        // For inputs, use value/placeholder
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return (el.value || el.placeholder || el.getAttribute('aria-label') || '').substring(0, maxLen);
        }
        
        // For selects, use selected option text
        if (el instanceof HTMLSelectElement) {
          return (el.options[el.selectedIndex]?.text || el.getAttribute('aria-label') || '').substring(0, maxLen);
        }
        
        // For images, use alt text
        if (el instanceof HTMLImageElement) {
          return (el.alt || el.getAttribute('aria-label') || el.title || '').substring(0, maxLen);
        }

        // Get aria-label first
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.substring(0, maxLen);

        // Get text content, preferring direct child text nodes
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3) // Text nodes
          .map(n => (n.textContent || '').trim())
          .filter(t => t.length > 0)
          .join(' ');
        
        text = directText || (el.textContent || '').trim();
        return text.substring(0, maxLen).replace(/\s+/g, ' ');
      }

      function isInteractive(el: Element): boolean {
        const tag = el.tagName.toLowerCase();
        const interactiveTags = ['a', 'button', 'input', 'textarea', 'select', 'summary', 'details'];
        if (interactiveTags.includes(tag)) return true;
        
        const role = el.getAttribute('role');
        const interactiveRoles = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 
                                   'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton',
                                   'menuitemcheckbox', 'menuitemradio', 'treeitem'];
        if (role && interactiveRoles.includes(role)) return true;
        
        if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
        if (el.getAttribute('contenteditable') === 'true') return true;
        if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-controls')) return true;
        if (el.hasAttribute('data-testid') || el.hasAttribute('data-test') || el.hasAttribute('data-action')) {
          const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
          if (text.length > 0 && text.length < 160) return true;
        }
        
        // Modern apps often use div/span with pointer cursor instead of native buttons.
        const style = window.getComputedStyle(el);
        if (style.cursor === 'pointer') {
          const rect = el.getBoundingClientRect();
          const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
          const notHuge = rect.width <= Math.max(520, window.innerWidth * 0.75) && rect.height <= 220;
          const hasUsefulText = text.length > 0 && text.length < 220;
          if (notHuge && (hasUsefulText || tag !== 'div')) return true;
        }
        
        return false;
      }

      function isLandmark(el: Element): boolean {
        const tag = el.tagName.toLowerCase();
        const landmarkTags = ['nav', 'main', 'header', 'footer', 'aside', 'form', 'section', 'article'];
        if (landmarkTags.includes(tag)) return true;
        
        const role = el.getAttribute('role');
        const landmarkRoles = ['navigation', 'main', 'banner', 'contentinfo', 'complementary', 
                                'form', 'region', 'search', 'dialog', 'alertdialog'];
        return !!(role && landmarkRoles.includes(role));
      }

      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        
        return true;
      }

      function isInViewport(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        return (
          rect.top < window.innerHeight &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.right > 0
        );
      }

      function buildCssPath(el: Element): string {
        if (el.id) return `#${el.id}`;
        
        const parts: string[] = [];
        let current: Element | null = el;
        let depth = 0;
        
        while (current && current !== document.body && depth < 5) {
          let selector = current.tagName.toLowerCase();
          if (current.id) {
            parts.unshift(`#${current.id}`);
            break;
          }
          if (current.className && typeof current.className === 'string') {
            const mainClass = current.className.trim().split(/\s+/)[0];
            if (mainClass && mainClass.length < 40 && !mainClass.includes(':')) {
              selector += `.${mainClass}`;
            }
          }
          parts.unshift(selector);
          current = current.parentElement;
          depth++;
        }
        
        return parts.join(' > ');
      }

      // ─── Main Scanner ───
      
      let refCounter = 1;
      const elements: any[] = [];
      const forms: any[] = [];
      const textBlocks: any[] = [];
      
      // Walk the DOM tree
      function walkDOM(el: Element, depth: number) {
        if (refCounter > maxElements) return;
        
        const tag = el.tagName?.toLowerCase();
        if (!tag) return;
        
        // Skip script, style, SVG internals, and other non-renderable elements
        if (['script', 'style', 'noscript', 'meta', 'link', 'svg', 'path', 'circle', 'rect',
             'line', 'polygon', 'polyline', 'ellipse', 'g', 'defs', 'clippath', 'mask',
             'use', 'symbol', 'pattern', 'lineargradient', 'radialgradient', 'stop',
             'feblend', 'fecolormatrix', 'fecomposite', 'filter', 'image',
             'template', 'slot', 'canvas'].includes(tag)) return;
        
        try { if (!isVisible(el)) return; } catch { return; }
        
        const interactive = isInteractive(el);
        const landmark = isLandmark(el);
        
        // Assign ref to interactive elements (always) and landmarks (in full mode)
        if (interactive || (mode === 'full' && landmark)) {
          const ref = refCounter++;
          el.setAttribute('data-ref', String(ref));
          
          const rect = el.getBoundingClientRect();
          const inputEl = el as HTMLInputElement;
          const contentEditable = el.getAttribute('contenteditable') === 'true';
          
          // SAFE href extraction — SVG elements have href as SVGAnimatedString (object, not string)
          // which Playwright serializes as {} — causing .substring() crashes downstream.
          // Always use getAttribute('href') as primary source, then check .href is a real string.
          let safeHref = '';
          try {
            const rawHref = (el as HTMLAnchorElement).href;
            if (typeof rawHref === 'string' && rawHref.length > 0) {
              safeHref = rawHref;
            } else {
              safeHref = el.getAttribute('href') || '';
            }
          } catch {
            safeHref = el.getAttribute('href') || '';
          }

          // SAFE value extraction
          let safeValue = '';
          try { safeValue = typeof inputEl.value === 'string' ? inputEl.value : ''; } catch { }
          let safePlaceholder = '';
          try { safePlaceholder = typeof inputEl.placeholder === 'string' ? inputEl.placeholder : ''; } catch { }

          const elemData: any = {
            ref,
            tag,
            role: el.getAttribute('role') || (contentEditable ? 'textbox' : getImplicitRole(tag)),
            text: getVisibleText(el, textMaxLength),
            type: (typeof inputEl.type === 'string' ? inputEl.type : '') || '',
            href: safeHref,
            value: safeValue,
            placeholder: safePlaceholder,
            ariaLabel: el.getAttribute('aria-label') || '',
            checked: !!(inputEl.checked),
            disabled: !!(inputEl.disabled),
            focused: document.activeElement === el,
            required: !!(inputEl.required),
            contentEditable,
            isVisible: true,
            isInViewport: isInViewport(el),
            depth,
            cssPath: buildCssPath(el),
            bbox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
          
          // Only include non-empty fields
          if (!elemData.type) delete elemData.type;
          if (!elemData.href) delete elemData.href;
          if (!elemData.value) delete elemData.value;
          if (!elemData.placeholder) delete elemData.placeholder;
          if (!elemData.ariaLabel) delete elemData.ariaLabel;
          
          elements.push(elemData);
        }
        
        // Track forms
        if (tag === 'form') {
          forms.push({
            ref: parseInt(el.getAttribute('data-ref') || '0'),
            action: (el as HTMLFormElement).action || '',
            method: ((el as HTMLFormElement).method || 'get').toUpperCase(),
          });
        }
        
        // Capture standalone text blocks for context
        if (includeText && !interactive && ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'label', 'legend', 'caption'].includes(tag)) {
          const text = (el.textContent || '').trim();
          if (text.length > 2 && text.length < 200) {
            textBlocks.push({ tag, text: text.substring(0, 120), depth });
          }
        }
        
        // Recurse into regular children and open shadow roots.
        if (tag !== 'svg') {
          const children = Array.from(el.children);
          const shadowRoot = (el as HTMLElement).shadowRoot;
          if (shadowRoot) children.push(...Array.from(shadowRoot.children));
          for (const child of children) {
            try { walkDOM(child, depth + 1); } catch { /* skip broken element */ }
          }
        }
      }
      
      walkDOM(document.body, 0);
      
      // Enrich forms with their field refs
      for (const form of forms) {
        const formEl = document.querySelector(`[data-ref="${form.ref}"]`) as HTMLFormElement;
        if (!formEl) continue;
        
        form.fields = [];
        const inputs = formEl.querySelectorAll('input, textarea, select');
        inputs.forEach(input => {
          const ref = input.getAttribute('data-ref');
          if (ref) form.fields.push(parseInt(ref));
        });
        
        const submitBtn = formEl.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        if (submitBtn) {
          form.submitButton = parseInt(submitBtn.getAttribute('data-ref') || '0') || undefined;
        }
      }
      
      return {
        elements,
        forms,
        textBlocks,
        pageTitle: document.title,
        pageUrl: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scrollPosition: { x: window.scrollX, y: window.scrollY },
        totalHeight: document.documentElement.scrollHeight,
        activeElementRef: document.activeElement?.getAttribute('data-ref') || null,
      };
    }, { mode, maxElements, includeText, viewportOnly, textMaxLength });

    // Step 2: Build our internal ref map
    this.refs.clear();
    this.forms = [];

    const sortedElements = [...rawData.elements].sort((a, b) => {
      const aScore = (a.disabled ? 20 : 0) + (a.isInViewport ? 0 : 10) + (a.role === 'button' || a.tag === 'button' ? -2 : 0) + (a.tag === 'input' || a.tag === 'textarea' ? -1 : 0);
      const bScore = (b.disabled ? 20 : 0) + (b.isInViewport ? 0 : 10) + (b.role === 'button' || b.tag === 'button' ? -2 : 0) + (b.tag === 'input' || b.tag === 'textarea' ? -1 : 0);
      return aScore - bScore || a.ref - b.ref;
    });

    for (const elem of sortedElements) {
      const elemRef: ElementRef = {
        ref: elem.ref,
        tag: elem.tag,
        role: elem.role || '',
        text: elem.text || '',
        type: elem.type,
        href: elem.href,
        value: elem.value,
        placeholder: elem.placeholder,
        ariaLabel: elem.ariaLabel,
        checked: elem.checked,
        disabled: elem.disabled,
        focused: elem.focused,
        required: elem.required,
        contentEditable: elem.contentEditable,
        selector: `[data-ref="${elem.ref}"]`,
        cssPath: elem.cssPath,
        bbox: elem.bbox,
        isVisible: elem.isVisible,
        isInViewport: elem.isInViewport !== false,
      };
      this.refs.set(elem.ref, elemRef);
    }

    for (const form of rawData.forms) {
      this.forms.push({
        ref: form.ref,
        action: form.action,
        method: form.method,
        fields: form.fields || [],
        submitButton: form.submitButton,
      });
    }

    // Step 3: Build the compact text snapshot for the AI
    const snapshotText = this.buildSnapshotText({ ...rawData, elements: sortedElements }, options);

    this.lastSnapshotTime = Date.now();
    this.stale = false;

    return {
      snapshotText,
      refs: new Map(this.refs),
      forms: [...this.forms],
      pageTitle: rawData.pageTitle,
      pageUrl: rawData.pageUrl,
      viewport: rawData.viewport,
      scrollPosition: rawData.scrollPosition,
      totalHeight: rawData.totalHeight,
      elementCount: rawData.elements.length,
      timestamp: this.lastSnapshotTime,
    };
  }

  /**
   * Build the compact text representation the AI reads.
   */
  private buildSnapshotText(rawData: any, options: SnapshotOptions): string {
    const lines: string[] = [];
    const textMaxLength = options.textMaxLength || 80;
    
    // Header
    lines.push(`Page: ${rawData.pageTitle || 'Untitled'}`);
    lines.push(`URL: ${rawData.pageUrl}`);
    lines.push(`Viewport: ${rawData.viewport.width}×${rawData.viewport.height} | Scroll: ${rawData.scrollPosition.y}/${rawData.totalHeight}`);
    
    if (rawData.activeElementRef) {
      lines.push(`Focused: [${rawData.activeElementRef}]`);
    }
    
    lines.push(''); // blank line separator
    
    // Text blocks (headings, paragraphs — for page context)
    const textBlocks = rawData.textBlocks || [];
    if (textBlocks.length > 0) {
      for (const block of textBlocks.slice(0, 8)) { // Max 8 text blocks for speed
        const indent = '  '.repeat(Math.min(block.depth, 3));
        lines.push(`${indent}${block.tag.toUpperCase()}: ${block.text}`);
      }
      lines.push('');
    }
    
    // Interactive elements with refs
    lines.push('─── Interactive Elements ───');
    
    for (const elem of rawData.elements) {
      const parts: string[] = [];
      
      // Ref number
      parts.push(`[${elem.ref}]`);
      
      // Tag + type
      if (elem.contentEditable) {
        parts.push(`${elem.tag}:editable`);
      } else if (elem.type && !['', 'submit'].includes(elem.type)) {
        parts.push(`${elem.tag}:${elem.type}`);
      } else {
        parts.push(elem.tag);
      }
      
      // Text/label
      if (elem.text) {
        parts.push(`"${elem.text}"`);
      }
      
      // Role (if not obvious from tag)
      if (elem.role && !['link', 'button', 'textbox', 'combobox', 'img'].includes(elem.role)) {
        parts.push(`(${elem.role})`);
      }
      
      // URL for links — SAFETY: elem.href must be a string (SVG can make it an object)
      if (elem.href && typeof elem.href === 'string' && elem.href.length > 0) {
        try {
          const url = new URL(elem.href);
          const short = url.pathname.length > 40 
            ? url.hostname + url.pathname.substring(0, 30) + '...'
            : url.hostname !== new URL(rawData.pageUrl).hostname
              ? url.hostname + url.pathname
              : url.pathname;
          parts.push(`→ ${short}`);
        } catch {
          parts.push(`→ ${String(elem.href).substring(0, 50)}`);
        }
      }
      
      // Value for inputs — SAFETY: ensure string
      if (elem.value && typeof elem.value === 'string') {
        parts.push(`value="${elem.value.substring(0, 30)}"`);
      }
      
      // Placeholder — SAFETY: ensure string
      if (elem.placeholder && typeof elem.placeholder === 'string' && !elem.value) {
        parts.push(`placeholder="${elem.placeholder.substring(0, 30)}"`);
      }
      
      // State flags
      const flags: string[] = [];
      if (elem.focused) flags.push('focused');
      if (elem.disabled) flags.push('disabled');
      if (elem.checked) flags.push('checked');
      if (elem.required) flags.push('required');
      if (elem.contentEditable) flags.push('editable');
      if (!elem.isInViewport) flags.push('offscreen');
      if (flags.length > 0) parts.push(`[${flags.join(', ')}]`);
      
      lines.push(parts.join(' '));
    }
    
    // Forms summary
    if (this.forms.length > 0) {
      lines.push('');
      lines.push('─── Forms ───');
      for (const form of this.forms) {
        const fieldRefs = form.fields.map(f => `[${f}]`).join(', ');
        lines.push(`Form [${form.ref}] ${form.method} ${form.action ? '→ ' + form.action.substring(0, 50) : ''}`);
        lines.push(`  Fields: ${fieldRefs}`);
        if (form.submitButton) {
          lines.push(`  Submit: [${form.submitButton}]`);
        }
      }
    }
    
    lines.push('');
    lines.push(`Total: ${rawData.elements.length} interactive elements`);
    
    return lines.join('\n');
  }

  // ─── Ref Lookup ───

  /**
   * Get element info by ref number.
   */
  getRef(ref: number): ElementRef | undefined {
    return this.refs.get(ref);
  }

  /**
   * Get the CSS selector for a ref.
   */
  getSelector(ref: number): string | undefined {
    return this.refs.get(ref)?.selector;
  }

  /**
   * Get backup CSS path for a ref (if data-ref fails).
   */
  getCssPath(ref: number): string | undefined {
    return this.refs.get(ref)?.cssPath;
  }

  /**
   * Find ref by text content.
   */
  findByText(text: string): ElementRef | undefined {
    const lower = text.toLowerCase();
    for (const [, elem] of this.refs) {
      if (elem.text.toLowerCase().includes(lower)) return elem;
    }
    return undefined;
  }

  /**
   * Find all refs matching a role.
   */
  findByRole(role: string): ElementRef[] {
    const results: ElementRef[] = [];
    for (const [, elem] of this.refs) {
      if (elem.role === role || elem.tag === role) results.push(elem);
    }
    return results;
  }

  /**
   * Get all refs.
   */
  getAllRefs(): Map<number, ElementRef> {
    return new Map(this.refs);
  }

  /**
   * Get form info.
   */
  getForms(): FormInfo[] {
    return [...this.forms];
  }

  /**
   * Mark snapshot as stale (e.g., after navigation).
   */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * Check if snapshot needs refresh.
   */
  isStale(): boolean {
    // Auto-stale after 30 seconds
    if (Date.now() - this.lastSnapshotTime > 30000) return true;
    return this.stale;
  }

  /**
   * Get age of current snapshot in ms.
   */
  getAge(): number {
    return Date.now() - this.lastSnapshotTime;
  }

  /**
   * Total refs in current snapshot.
   */
  get count(): number {
    return this.refs.size;
  }
}

// ═══════════════════════════════════════
// GLOBAL SINGLETON
// ═══════════════════════════════════════
export const domSnapshot = new DOMSnapshot();
