export function makeScope(user, isAnonymous) {
  const uid = user?.$id ? String(user.$id).trim() : "";
  if (!uid) return null;
  return isAnonymous ? `anon:${uid}` : `user:${uid}`;
}

// Include legacy scopes so old cached media still works after a migration
export function scopeCandidates(user, isAnonymous) {
  const uid = user?.$id ? String(user.$id).trim() : "";
  const primary = makeScope(user, isAnonymous);

  const arr = [];
  if (primary) arr.push(primary);

  // Legacy / migration candidates (what you used before)
  if (uid) arr.push(uid);
  arr.push("guest");

  // Also include both prefixes in case anon<->user changed between sessions
  if (uid) arr.push(`anon:${uid}`, `user:${uid}`);

  return Array.from(new Set(arr.filter(Boolean)));
}
