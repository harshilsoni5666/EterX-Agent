const MAX_RELEASE_NOTES_BYTES = 64 * 1024;
const RELEASE_NOTE_LABELS = { new: 'New', improved: 'Improved', fixed: 'Fixed', security: 'Security' };

function plainText(value, limit) {
  if (typeof value !== 'string' || value.length > limit) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Release highlights are authored for customers. Never turn arbitrary commit
// messages, HTML, or generated GitHub changelogs into in-app product claims.
function normalizeReleaseNotes(value, expectedVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof expectedVersion !== 'string' || value.version !== expectedVersion) return null;
  const summary = plainText(value.summary, 600);
  if (!summary || !Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 4) return null;
  const sections = [];
  const kinds = new Set();
  let itemCount = 0;
  for (const section of value.sections) {
    if (!section || !Object.hasOwn(RELEASE_NOTE_LABELS, section.kind) || kinds.has(section.kind)) return null;
    if (!Array.isArray(section.items) || section.items.length < 1) return null;
    kinds.add(section.kind);
    const items = [];
    for (const item of section.items) {
      if (++itemCount > 100) return null;
      const title = plainText(item?.title, 160);
      const description = item?.description == null ? '' : plainText(item.description, 2000);
      if (!title || description === null) return null;
      items.push({ title, description });
    }
    sections.push({ kind: section.kind, items });
  }
  const result = { version: expectedVersion, summary, sections };
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_RELEASE_NOTES_BYTES ? result : null;
}

module.exports = { normalizeReleaseNotes, MAX_RELEASE_NOTES_BYTES, RELEASE_NOTE_LABELS };
