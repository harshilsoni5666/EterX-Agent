'use client';

import { Sparkles } from 'lucide-react';
import type { DesktopReleaseNotes, DesktopUpdateState } from '../../lib/desktop-updates';

const sectionLabels: Record<DesktopReleaseNotes['sections'][number]['kind'], string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  security: 'Security',
};

function ReleaseNotesContent({ notes }: { notes: DesktopReleaseNotes }) {
  return (
    <div className="space-y-6">
      <p className="break-words [overflow-wrap:anywhere] eterx-release-summary text-[13px] leading-relaxed">
        {notes.summary}
      </p>
      {notes.sections.map(section => (
        <div key={section.kind}>
          <h4 className="eterx-release-category-heading">
            <span className="eterx-release-category" data-kind={section.kind}>{sectionLabels[section.kind]}</span>
          </h4>
          <ul className="mt-3 space-y-4">
            {section.items.map((item, index) => (
              <li key={`${section.kind}-${index}`} className="min-w-0 break-words [overflow-wrap:anywhere]">
                <p className="leading-5 text-[13px] font-semibold">{item.title}</p>
                {item.description && (
                  <p className="eterx-release-muted mt-1 text-[12.5px] leading-[1.75]">
                    {item.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function UpdateWhatsNew({ state }: { state: DesktopUpdateState }) {
  const version = state.availableVersion || state.currentVersion;
  const notes = state.releaseNotes?.version === version ? state.releaseNotes : null;
  const releaseDate = state.availableVersion && state.releaseDate ? new Date(state.releaseDate) : null;
  const dateLabel = releaseDate && Number.isFinite(releaseDate.getTime())
    ? releaseDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  if (!notes) return null;

  return (
    <section className="eterx-release-highlights mt-7 min-w-0 overflow-hidden rounded-xl border" aria-label="What’s New">
      <header className="eterx-release-header flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="eterx-release-icon flex size-9 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[19px] font-semibold leading-tight tracking-[-0.025em]">What’s New</h3>
            {version !== 'development' && (
              <p className="eterx-release-muted mt-1 text-[11.5px] leading-4 [overflow-wrap:anywhere]">
                EterX {version}{dateLabel ? ` · ${dateLabel}` : ''}
              </p>
            )}
          </div>
        </div>
        {version !== 'development' && (
          <span className="eterx-release-version rounded-full border px-2.5 py-1 text-[11px] font-medium" data-available={Boolean(state.availableVersion)}>
            {state.availableVersion ? 'New release' : 'Installed version'}
          </span>
        )}
      </header>
      <div className="px-4 py-5 sm:px-5">
        <ReleaseNotesContent notes={notes} />
      </div>
    </section>
  );
}
