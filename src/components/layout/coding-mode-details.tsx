import { ArrowLeft } from 'lucide-react';
import { CODING_TOOL_DETAILS, getCodingMode, type CodingAgentId } from '../../lib/code/coding-modes';

export function CodingModeDetails({ modeId, onBack }: { modeId: CodingAgentId; onBack: () => void }) {
  const mode = getCodingMode(modeId)!;
  return (
    <section className="eterx-coding-details p-1" aria-label={`${mode.label} tools`}>
      <button type="button" autoFocus onClick={onBack}
        className="flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        aria-label="Back to agent selection">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{mode.label}</span>
      </button>
      <p className="px-2 pb-3 text-[12px] leading-5 opacity-65">{mode.description}</p>
      <ul className="space-y-3 px-2 pb-3">
        {mode.tools.map(name => (
          <li key={name}>
            <div className="text-[12px] font-medium">{CODING_TOOL_DETAILS[name].label}</div>
            <p className="mt-0.5 text-[11.5px] leading-[17px] opacity-65">{CODING_TOOL_DETAILS[name].description}</p>
          </li>
        ))}
      </ul>
      <p className="border-t border-current/10 px-2 pt-3 pb-1 text-[11px] leading-[17px] opacity-60">
        {mode.tools.length} tools. Existing permissions still apply. Autonomous supervision works with this mode; selection changes apply to the next turn.
      </p>
    </section>
  );
}
