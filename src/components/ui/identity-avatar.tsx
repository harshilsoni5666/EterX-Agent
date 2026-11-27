import styles from './identity-avatar.module.css';

const TONE_COUNT = 6;

export type IdentityAvatarDescriptor = {
  initials: string;
  tone: number;
};

export type IdentityAvatarProps = {
  /** A stable ID such as an account ID or local profile key. */
  identity: string;
  /** The visible name or email used to derive the initials. */
  name: string;
  size?: number;
  shape?: 'circle' | 'rounded';
  label?: string;
  className?: string;
  descriptor?: IdentityAvatarDescriptor;
};

function getInitials(name: string): string {
  const normalizedName = name.trim().normalize('NFKC');
  if (!normalizedName) return 'U';

  // Email addresses use their first character so dots and underscores in a
  // mailbox do not turn into artificial multi-part names.
  const source = normalizedName.includes('@') ? normalizedName.slice(0, normalizedName.indexOf('@')) : normalizedName;
  const parts = source.split(/\s+/).filter(Boolean);
  const first = Array.from(parts[0] || source)[0] || 'U';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
  return `${first}${last}`.toUpperCase();
}

function getStableTone(identity: string, fallback: string): number {
  const seed = (identity.trim() || fallback.trim() || 'user').normalize('NFKC').toLowerCase();
  let hash = 2166136261;

  for (const character of seed) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % TONE_COUNT;
}

/** Generate a stable letter and neutral gray tone for any named identity. */
export function generateIdentityAvatar(identity: string, name: string): IdentityAvatarDescriptor {
  return {
    initials: getInitials(name),
    tone: getStableTone(identity, name),
  };
}

function folderInitials(name: string): string {
  const words = name.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || ['Folder'];
  const first = Array.from(words[0]);
  const last = Array.from(words[words.length - 1]);
  const initials = words.length > 1 ? first[0] + last[0] : first.slice(0, 2).join('');
  return Array.from(initials.toUpperCase()).slice(0, 2).join('');
}

/** Reserve each folder's preferred monogram before assigning alternatives. */
export function assignFolderAvatars(folders: ReadonlyMap<string, string>): Map<string, IdentityAvatarDescriptor> {
  const avatars = new Map<string, IdentityAvatarDescriptor>();
  const used = new Set<string>();
  const collisions: Array<{ identity: string; initials: string; tone: number }> = [];

  for (const identity of Array.from(folders.keys()).sort()) {
    const name = folders.get(identity) || 'Folder';
    const initials = folderInitials(name);
    const tone = getStableTone(identity, name);
    if (used.has(initials)) {
      collisions.push({ identity, initials, tone });
    } else {
      used.add(initials);
      avatars.set(identity, { initials, tone });
    }
  }

  const nextSuffix = new Map<string, number>();
  for (const { identity, initials, tone } of collisions) {
    const prefix = Array.from(initials)[0];
    let suffix = nextSuffix.get(prefix) ?? 1;
    let monogram: string;
    do {
      monogram = prefix + (suffix++).toString(36).toUpperCase();
    } while (used.has(monogram));
    nextSuffix.set(prefix, suffix);
    used.add(monogram);
    avatars.set(identity, { initials: monogram, tone });
  }

  return avatars;
}

/** Reusable, deterministic initial avatar for named identities. */
export function IdentityAvatar({
  identity,
  name,
  size = 40,
  shape = 'circle',
  label,
  className = '',
  descriptor,
}: IdentityAvatarProps) {
  const { initials, tone } = descriptor ?? generateIdentityAvatar(identity, name);
  const compactFontSize = Math.floor((size - 2) / (Math.max(2, Array.from(initials).length) * 0.8));
  const fontSize = size < 24 ? Math.max(5, Math.min(Math.round(size / 2), compactFontSize))
    : Math.max(12, Math.round(size * 0.38));
  const classes = [styles.avatar, shape === 'rounded' && styles.rounded, className].filter(Boolean).join(' ');

  return (
    <span
      className={classes}
      data-tone={tone}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, fontSize }}
    >
      {initials}
    </span>
  );
}
