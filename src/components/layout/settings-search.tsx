import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Search, X, type LucideIcon } from 'lucide-react';
import { buildSettingsSearchIndex, searchSettings, type SettingsSearchResult, type SettingsSearchTab } from './settings-search-index';
import settingsPanelStyles from './settings-panel.module.css';
import styles from './settings-search.module.css';

export type SettingsSearchTabInfo = { id: SettingsSearchTab; label: string; icon: LucideIcon };

export function SettingsSearch({ tabs, activeTab, onSelect }: {
  tabs: readonly SettingsSearchTabInfo[];
  activeTab: string;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  const listId = useId();
  const headerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const index = useMemo(() => buildSettingsSearchIndex(tabs), [tabs]);
  const results = useMemo(() => searchSettings(index, query, activeTab), [index, query, activeTab]);
  const expanded = open && Boolean(query.trim());
  const activeResult = results[activeIndex];
  const enterResult = activeResult ?? results[0];

  const dismiss = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    const dropdown = dropdownRef.current;
    if (!expanded || !dropdown) return;
    if (results[activeIndex]) {
      dropdown.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    } else {
      dropdown.scrollTop = 0;
    }
  }, [activeIndex, expanded, results]);

  useEffect(() => {
    if (!expanded) return;
    const dismissOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('pointerdown', dismissOnOutsidePress);
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePress);
  }, [dismiss, expanded]);

  const select = (result: SettingsSearchResult) => {
    dismiss();
    setQuery('');
    onSelect(result);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    } else if (event.key === 'Tab') {
      dismiss();
    } else if (event.key === 'Enter' && expanded && enterResult) {
      event.preventDefault();
      select(enterResult);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && query.trim()) {
      event.preventDefault();
      setOpen(true);
      if (results.length) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex(current => {
          if (current < 0) return step === 1 ? 0 : results.length - 1;
          return (current + step + results.length) % results.length;
        });
      }
    }
  };

  return (
    <div ref={headerRef} className={styles.header} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) dismiss();
    }}>
      <div className={styles.field}>
        <Search className={styles.searchIcon} size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          role="combobox"
          type="text"
          aria-label="Search settings"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && activeResult ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={160}
          value={query}
          placeholder="Search"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {query && <button type="button" className={styles.clear} aria-label="Clear settings search" onClick={() => {
          setQuery('');
          setActiveIndex(-1);
          inputRef.current?.focus();
        }}><X size={14} aria-hidden="true" /></button>}
      </div>
      {expanded && (
        <div ref={dropdownRef} className={`${settingsPanelStyles.menuSurface} ${styles.dropdown} eterx-scrollbar`}>
          <ul className={styles.list} id={listId} role="listbox" aria-label="Matching settings">
            {results.map((result, position) => {
              const tab = tabs.find(tab => tab.id === result.tab)!;
              const Icon = tab.icon;
              return (
                <li
                  key={`${result.tab}:${result.target}`}
                  id={`${listId}-${position}`}
                  role="option"
                  aria-selected={position === activeIndex}
                  className={styles.option}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => select(result)}
                >
                  <span className={styles.optionIcon}><Icon size={15} strokeWidth={1.8} aria-hidden="true" /></span>
                  <span className={styles.optionCopy}>
                    <span className={styles.optionTitle}>{result.title}</span>
                    <span className={styles.optionPath}>{tab.label}{result.section && <> <span aria-hidden="true">/</span> {result.section}</>}</span>
                  </span>
                  <ChevronRight className={styles.optionArrow} size={14} aria-hidden="true" />
                </li>
              );
            })}
          </ul>
          {!results.length && <div className={styles.empty}>
            <strong>No settings found</strong>
            <span>Try a setting name or keyword.</span>
          </div>}
        </div>
      )}
      <div className="sr-only" role="status">{expanded ? `${results.length} ${results.length === 1 ? 'setting' : 'settings'} found` : ''}</div>
    </div>
  );
}
