'use client';

import { Sparkles } from 'lucide-react';
import type { DesktopReleaseNotes, DesktopUpdateState } from '../../lib/desktop-updates';

const sectionLabels: Record<DesktopReleaseNotes['sections'][number]['kind'], string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  security: 'Security',
};

export function ReleaseNotesContent({ notes, compact = false }: { notes: DesktopReleaseNotes | null; compact?: boolean }) {
  if (!notes) {
    return (
      <p className="eterx-release-muted text-[12px] leading-relaxed">
        Release highlights aren’t available for this version right now.
      </p>
    );
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      <p className={`eterx-release-muted break-words [overflow-wrap:anywhere] ${compact ? 'text-[12px] leading-[1.65]' : 'text-[13px] leading-6'}`}>
        {notes.summary}
      </p>
      {notes.sections.map(section => (
        <div key={section.kind}>
          <span className="eterx-release-category" data-kind={section.kind}>{sectionLabels[section.kind]}</span>
          <ul className={compact ? 'mt-2.5 space-y-3' : 'mt-3 space-y-4'}>
            {section.items.map((item, index) => (
              <li key={`${section.kind}-${index}`} className="min-w-0 break-words [overflow-wrap:anywhere]">
                <p className={`font-medium ${compact ? 'text-[12px] leading-5' : 'text-[13px] leading-5'}`}>{item.title}</p>
                {item.description && (
                  <p className={`eterx-release-muted mt-1 ${compact ? 'text-[11.5px] leading-[1.65]' : 'text-[12.5px] leading-[1.75]'}`}>
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

  return (
    <section className="eterx-release-highlights rounded-xl border p-5" aria-label="What’s New">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <Sparkles size={16} className="eterx-release-accent" aria-hidden="true" />
            What’s New
          </h3>
          {version !== 'development' && (
            <p className="eterx-release-muted mt-1.5 text-[11px]">
              EterX {version}{dateLabel ? ` · ${dateLabel}` : ''}
            </p>
          )}
        </div>
        {version !== 'development' && (
          <span className="eterx-release-version rounded-full border px-2.5 py-1 text-[10.5px] font-medium">
            {state.availableVersion ? 'New release' : 'Installed version'}
          </span>
        )}
      </div>
      <ReleaseNotesContent notes={notes} />
    </section>
  );
}
