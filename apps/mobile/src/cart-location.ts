/** Compact presentation only. Never substitutes a different branch or changes order ownership. */
export function cartLocationName(name: string | null | undefined): string {
  const full = name?.trim() ?? '';
  // The approved bar uses the mall's own name, while VoiceOver keeps its full localized name.
  return full.replace(/^(?:ТЦ|ТРЦ)\s+/u, '').trim() || full;
}
