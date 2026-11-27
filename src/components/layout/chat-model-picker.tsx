'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useIsPresent, useReducedMotion } from 'framer-motion';
import { Check, ChevronRight, Search, Zap } from 'lucide-react';
import { groupModelsByProvider } from '../../lib/agent/model-presentation';
import type { MainAgentProvider, MainAgentThinkingLevel, ModelThinkingOption } from '../../lib/agent/model-routing';
import { AdaptiveMenu } from '../ui/adaptive-menu';
import { ModelProviderIconAsset } from '../ui/provider-icon';
import { ModelBadges, usePausedProviders } from '../updates/model-badges';

type PickerModel = {
  optionKey: string;
  provider: MainAgentProvider;
  label: string;
  modelName: string;
};

type PickerScrollKey = MainAgentProvider | 'providers';
export type ModelPickerScrollPositions = Map<PickerScrollKey, number>;

type ChatModelPickerProps<Model extends PickerModel> = {
  anchorRef: RefObject<HTMLDivElement | null>;
  openBelow: boolean;
  models: Model[];
  loading: boolean;
  onOpenApiSettings?: () => void;
  selectedModel: Model | null;
  browsedProvider: MainAgentProvider | null;
  onBrowseProvider: (provider: MainAgentProvider) => void;
  scrollPositions: RefObject<ModelPickerScrollPositions>;
  providerLabels: Record<MainAgentProvider, string>;
  getThinkingOptions: (model: Model) => ModelThinkingOption[];
  getThinkingLevel: (model: Model) => MainAgentThinkingLevel | null;
  getFastMode: (model: Model) => boolean | null;
  onSelectModel: (model: Model) => void;
  onSelectThinking: (model: Model, level: MainAgentThinkingLevel) => void;
  onChangeFastMode: (model: Model, enabled: boolean) => void;
  onClose: () => void;
};

function PickerScrollPane({ resetKey, revealSelection, scrollKey, scrollPositions, onScroll, children }: {
  resetKey: string;
  revealSelection: boolean;
  scrollKey?: PickerScrollKey;
  scrollPositions: RefObject<ModelPickerScrollPositions>;
  onScroll?: () => void;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isPresent = useIsPresent();

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const savedScrollTop = scrollKey === undefined ? undefined : scrollPositions.current.get(scrollKey);
    if (savedScrollTop !== undefined) {
      // Restore after AdaptiveMenu has fit the pane to the viewport.
      const frame = requestAnimationFrame(() => { list.scrollTop = savedScrollTop; });
      return () => cancelAnimationFrame(frame);
    }
    list.scrollTop = 0;
    const selected = revealSelection && list.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!selected) return;
    const reveal = () => {
      const start = selected.offsetTop;
      const end = start + selected.offsetHeight;
      if (start < list.scrollTop || end > list.scrollTop + list.clientHeight) {
        list.scrollTop = start - (list.clientHeight - selected.offsetHeight) / 2;
      }
    };
    reveal();
    // AdaptiveMenu may shorten the pane after its children mount.
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [resetKey, revealSelection, scrollKey, scrollPositions]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    const updateEdges = () => {
      list.toggleAttribute('data-fade-top', list.scrollTop > 1);
      list.toggleAttribute('data-fade-bottom', list.scrollHeight - list.clientHeight - list.scrollTop > 1);
    };
    const observer = new ResizeObserver(updateEdges);
    observer.observe(list);
    observer.observe(content);
    list.addEventListener('scroll', updateEdges, { passive: true });
    updateEdges();
    return () => {
      observer.disconnect();
      list.removeEventListener('scroll', updateEdges);
    };
  }, []);

  return (
    <div ref={listRef} className="eterx-model-picker-scroll" data-menu-scroll-region onScroll={event => {
      if (isPresent && scrollKey !== undefined) {
        scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop);
      }
      onScroll?.();
    }}>
      <div ref={contentRef} className="eterx-model-picker-choices">{children}</div>
    </div>
  );
}

export function ChatModelPicker<Model extends PickerModel>({
  anchorRef, openBelow, models, loading, onOpenApiSettings, selectedModel, browsedProvider, onBrowseProvider, scrollPositions,
  providerLabels, getThinkingOptions, getThinkingLevel, getFastMode,
  onSelectModel, onSelectThinking, onChangeFastMode, onClose,
}: ChatModelPickerProps<Model>) {
  const paused = usePausedProviders();
  const [search, setSearch] = useState('');
  const [thinkingAnchor, setThinkingAnchor] = useState<{ key: string; button: HTMLButtonElement } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const dismissTimer = useRef<number>(undefined);
  const thinkingMenuId = useId();
  const isPresent = useIsPresent();
  const reduceMotion = useReducedMotion();

  const groups = useMemo(() => groupModelsByProvider(models), [models]);
  const query = search.trim().toLowerCase();
  const matchingGroups = useMemo(() => query
    ? groupModelsByProvider(models.filter(model =>
        `${model.label} ${providerLabels[model.provider]} ${model.modelName}`.toLowerCase().includes(query)))
    : groups, [groups, models, providerLabels, query]);
  const group = matchingGroups.find(item => item.provider === (browsedProvider ?? selectedModel?.provider))
    ?? matchingGroups[0];
  const thinkingModel = group?.models.find(model => model.optionKey === thinkingAnchor?.key);
  const thinkingOptions = thinkingModel ? getThinkingOptions(thinkingModel) : [];
  const selectedThinkingLevel = thinkingModel ? getThinkingLevel(thinkingModel) : null;
  const openThinking = isPresent && Boolean(thinkingOptions.length);
  const visibleRows = Math.min(7, Math.max(3, groups.length, ...groups.map(item => item.models.length)));
  const menuHeight = 112 + 34 * visibleRows;

  const cancelDismiss = () => window.clearTimeout(dismissTimer.current);
  const closeThinking = (restoreFocus = false) => {
    cancelDismiss();
    if (restoreFocus) thinkingAnchor?.button.focus({ preventScroll: true });
    setThinkingAnchor(null);
  };
  const scheduleDismiss = () => {
    cancelDismiss();
    dismissTimer.current = window.setTimeout(() => {
      if (!thinkingRef.current?.contains(document.activeElement)) setThinkingAnchor(null);
    }, 180);
  };

  useEffect(() => () => window.clearTimeout(dismissTimer.current), []);

  useEffect(() => {
    if (!isPresent) return;
    const handlePointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if ([anchorRef.current, menuRef.current, thinkingRef.current].some(node => node && path.includes(node))) return;
      onClose();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onClose();
      anchorRef.current?.querySelector('button')?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [anchorRef, isPresent, onClose]);

  useLayoutEffect(() => {
    const menu = thinkingRef.current;
    const picker = menuRef.current;
    const row = thinkingAnchor?.button.parentElement;
    if (!openThinking || !menu || !picker || !row) return;
    const viewport = window.visualViewport;
    const position = () => {
      const margin = 12;
      const gap = 4;
      const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
      const topEdge = (viewport?.offsetTop ?? 0) + margin;
      const rightEdge = leftEdge + (viewport?.width ?? document.documentElement.clientWidth) - margin * 2;
      const bottomEdge = topEdge + (viewport?.height ?? document.documentElement.clientHeight) - margin * 2;
      const scale = menu.currentCSSZoom || 1;
      menu.style.visibility = window.getComputedStyle(picker).visibility;
      menu.style.setProperty('--thinking-max-height', `${Math.max(0, bottomEdge - topEdge) / scale}px`);
      const { width, height } = menu.getBoundingClientRect();
      const rowBounds = row.getBoundingClientRect();
      const pickerBounds = picker.getBoundingClientRect();
      const roomOnRight = rightEdge - pickerBounds.right >= width + gap;
      const preferredLeft = roomOnRight ? pickerBounds.right + gap : rowBounds.right - width;
      const rowEdge = rowBounds.bottom + height <= bottomEdge ? rowBounds.bottom : rowBounds.top - height;
      const preferredTop = roomOnRight ? rowBounds.top : rowEdge;
      const left = Math.max(leftEdge, Math.min(preferredLeft, rightEdge - width));
      const top = Math.max(topEdge, Math.min(preferredTop, bottomEdge - height));
      menu.style.left = `${left / scale}px`;
      menu.style.top = `${top / scale}px`;
    };
    position();
    const observer = new MutationObserver(position);
    observer.observe(picker, { attributeFilter: ['style'] });
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
    };
  }, [openThinking, thinkingAnchor, thinkingOptions.length]);

  const openFor = (key: string, button: HTMLButtonElement) => {
    cancelDismiss();
    setThinkingAnchor(current => current?.button === button ? current : { key, button });
  };
  const focusThinking = () => {
    const menu = thinkingRef.current;
    const target = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu?.querySelector('button');
    target?.focus({ preventScroll: true });
  };

  return (
    <>
      <AdaptiveMenu
        motionProps={{ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: reduceMotion ? 0 : 0.14 } }}
        preferredSide={openBelow ? 'bottom' : 'top'}
        allowFlip={!openBelow}
        heightLimit={menuHeight}
        style={{ height: menuHeight }}
        portalAnchorRef={anchorRef}
        menuRef={menuRef}
        className="eterx-model-menu-popout"
        inert={!isPresent}
        aria-hidden={!isPresent || undefined}
        role="dialog"
        aria-label="Model and thinking settings"
      >
        <div className="eterx-model-menu-title">Model</div>
        <div className="eterx-model-search relative">
          <Search className="pointer-events-none absolute top-1/2 size-3.5 -translate-y-1/2" aria-hidden="true" />
          <input autoFocus className="outline-hidden" aria-label="Search models and providers" placeholder="Search models / providers"
            value={search} onChange={event => {
              closeThinking();
              setSearch(event.target.value);
            }} />
        </div>
        <div className="eterx-model-picker-columns">
          <section className="eterx-model-picker-pane" aria-label="Providers">
            <div className="eterx-model-picker-heading">Providers</div>
            <PickerScrollPane resetKey={query} revealSelection={!query} scrollPositions={scrollPositions}
              scrollKey={!query && matchingGroups.length > 0 ? 'providers' : undefined}>
              {matchingGroups.map(({ provider }) => (
                <button key={provider} type="button" className="eterx-model-picker-provider" aria-pressed={group?.provider === provider}
                  title={providerLabels[provider]} onClick={() => {
                    closeThinking();
                    onBrowseProvider(provider);
                  }}>
                  <ModelProviderIconAsset provider={provider} className="eterx-model-provider-icon size-4" />
                  <span className="min-w-0 truncate">{providerLabels[provider]}</span>
                  {group?.provider === provider && <ChevronRight className="ml-auto size-3.5 shrink-0" aria-hidden="true" />}
                </button>
              ))}
            </PickerScrollPane>
          </section>
          <section className="eterx-model-picker-pane" aria-label={group ? `${providerLabels[group.provider]} models` : 'Models'}>
            <div className="eterx-model-picker-heading">{group ? providerLabels[group.provider] + ' models' : 'Models'}</div>
            <PickerScrollPane key={group?.provider} resetKey={`${query}\n${selectedModel?.optionKey ?? ''}`} revealSelection={!query}
              scrollPositions={scrollPositions} scrollKey={query ? undefined : group?.provider}
              onScroll={() => { if (thinkingAnchor) closeThinking(thinkingRef.current?.contains(document.activeElement)); }}>
              {group ? group.models.map(model => {
                const unavailable = paused.has(model.provider);
                const options = getThinkingOptions(model);
                const fast = getFastMode(model);
                const level = options.length ? options.find(option => option.id === getThinkingLevel(model)) : undefined;
                const expanded = openThinking && thinkingAnchor?.key === model.optionKey;
                return (
                  <div key={model.optionKey} className="eterx-model-picker-row"
                    data-thinking-open={expanded || undefined}
                    onMouseLeave={scheduleDismiss}>
                    <button type="button" className="eterx-model-picker-model" aria-pressed={model.optionKey === selectedModel?.optionKey}
                      disabled={unavailable}
                      title={unavailable ? 'Provider temporarily unavailable' : model.label === model.modelName ? model.label : model.modelName} onClick={() => {
                        anchorRef.current?.querySelector('button')?.focus({ preventScroll: true });
                        onSelectModel(model);
                      }}>
                      <span className="eterx-model-name-with-badges">
                        <span className="truncate">{model.label}</span>
                        {unavailable ? <span className="eterx-model-badge">Unavailable</span> : <ModelBadges provider={model.provider} modelId={model.modelName} />}
                      </span>
                    </button>
                    {!unavailable && fast !== null && (
                      <button type="button" className="eterx-model-picker-fast"
                        aria-label={`Fast mode for ${model.label}`} aria-pressed={fast}
                        title={`Fast ${fast ? 'on' : 'off'} · ${model.provider === 'openai' ? 'Higher API rates' : 'Uses plan or credits faster'}`}
                        onClick={() => { closeThinking(); onChangeFastMode(model, !fast); }}>
                        <Zap className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                    {!unavailable && options.length > 0 && (
                      <button type="button" className="eterx-model-picker-thinking-trigger"
                        aria-label={`Thinking level for ${model.label}${level ? `, current level ${level.label}` : ''}`}
                        aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? thinkingMenuId : undefined}
                        onClick={event => {
                          openFor(model.optionKey, event.currentTarget);
                          requestAnimationFrame(focusThinking);
                        }}>
                        <span>{level?.label}</span>
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              }) : (
                <div className="eterx-model-picker-empty">
                  <p role="status">{loading ? 'Loading models…' : query ? 'No matching models' : 'No models available'}</p>
                  {!query && !loading && onOpenApiSettings && (
                    <button type="button" className="mt-2 text-[var(--composer-menu-ink)] underline underline-offset-2" onClick={onOpenApiSettings}>
                      Open API settings
                    </button>
                  )}
                </div>
              )}
            </PickerScrollPane>
          </section>
        </div>
      </AdaptiveMenu>
      {openThinking && thinkingModel && createPortal(
        <div ref={thinkingRef} id={thinkingMenuId} className="eterx-model-thinking-popout eterx-model-picker-thinking"
          role="menu" aria-label={`Thinking level for ${thinkingModel.label}`}
          onMouseEnter={cancelDismiss} onMouseLeave={scheduleDismiss}
          onKeyDown={event => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              if (event.key === 'Escape') event.preventDefault();
              closeThinking(true);
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}>
          {thinkingOptions.map(option => {
            const checked = option.id === selectedThinkingLevel;
            return (
              <button key={option.id} type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1}
                onClick={() => {
                  onSelectThinking(thinkingModel, option.id);
                  closeThinking(true);
                }}>
                {option.label}
                {checked && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>, document.body)}
    </>
  );
}
