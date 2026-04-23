export function userInitials(user?: { email?: string; name?: string } | null): string {
  if (!user) return "?";
  const source = user.name || user.email || "";
  if (!source) return "?";
  const base = source.split("@")[0];
  const parts = base.split(/[.\-_ ]/).filter(Boolean).slice(0, 2);
  const initials = parts.map((p) => p[0]?.toUpperCase()).join("");
  return initials || base.slice(0, 2).toUpperCase();
}
