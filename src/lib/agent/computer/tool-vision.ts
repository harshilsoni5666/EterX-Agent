const desktopTools = new Set(['computer', 'screen_agent']);
export const MAX_DESKTOP_IMAGE_BASE64_LENGTH = 28 * 1024 * 1024;

/** Only small outcome fields belong on the chat activity row. */
export function desktopTraceOutcome(toolName: string, result: any) {
  if (!desktopTools.has(toolName) || !result) return {};
  return {
    ...(result.actionStatus ? { actionStatus: result.actionStatus } : {}),
    ...(result.observationRequired ? { observationRequired: true } : {}),
    ...(result.observationError ? { observationError: String(result.observationError).slice(0, 700) } : {}),
  };
}

/** Keep desktop pixels out of JSON compaction and pass them as native image input. */
export function splitComputerToolResult(toolName: string, value: any): {
  output: any;
  image?: { data: string; mimeType: 'image/png' | 'image/jpeg' };
} {
  if (!desktopTools.has(toolName) || !value || typeof value !== 'object') return { output: value };
  const { vision, _visionParts, ...output } = value;
  const data = vision?.inlineData?.data;
  const mimeType = vision?.inlineData?.mimeType;
  if (typeof data === 'string' && data.length > 16 && data.length <= MAX_DESKTOP_IMAGE_BASE64_LENGTH
    && (mimeType === 'image/png' || mimeType === 'image/jpeg')) {
    return { output, image: { data, mimeType } };
  }
  if (vision) {
    output.observationError = output.observationError || 'Screenshot could not be attached to the model request. Observe again before sending input.';
    // Preserve an already delivered mutation, but never report a successful
    // visual read when its pixels cannot be sent to the selected model.
    if (output.actionStatus !== 'sent') output.success = false;
  }
  return { output };
}
