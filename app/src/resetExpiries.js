// 使用采集时的绝对时间；重新渲染和缓存回放不能推迟重置机会的到期日期。
export function resetExpiries(account) {
  const entries = [];
  const credits = account.rate_limit_reset_credits;
  if (credits && typeof credits === "object") {
    const dates = Array.isArray(credits.expires_at_list) ? credits.expires_at_list : [];
    for (const raw of dates) {
      if (raw === null) entries.push({ label: "", at: null, noExpiry: true });
      else if (Number.isFinite(Number(raw)) && Number(raw) > 0) entries.push({ label: "", at: Number(raw) });
    }
    if (!entries.length && Number.isFinite(Number(credits.next_expires_at)) && Number(credits.next_expires_at) > 0) {
      entries.push({ label: "", at: Number(credits.next_expires_at) });
    }
    const count = Number(credits.available_count) || 0;
    for (let i = entries.length; i < count; i++) entries.push({ label: "", at: null });
  }
  const cards = account.reset_cards || {};
  const fetchedAt = Date.parse(account.fetched_at);
  const collected = Number.isFinite(fetchedAt) ? fetchedAt : Date.now();
  for (const [key, label] of [["five_hour", "5h"], ["week", "7d"]]) {
    for (const card of Array.isArray(cards[key]) ? cards[key] : []) {
      const absolute = Date.parse(card.expire_at);
      const relative = Number(card.expire_after_seconds);
      const at = Number.isFinite(absolute) ? absolute / 1000
        : Number.isFinite(relative) && relative > 0 ? collected / 1000 + relative : null;
      entries.push({ label, at });
    }
  }
  return entries.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}
