// Per-slug Server-Sent Events pub/sub for lightweight real-time sync notifications

const subscribers = new Map(); // slug -> Set<{ res, clientId }>

export function addSubscriber(slug, res, clientId) {
  if (!subscribers.has(slug)) {
    subscribers.set(slug, new Set());
  }
  const entry = { res, clientId };
  subscribers.get(slug).add(entry);

  return () => {
    const set = subscribers.get(slug);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) {
      subscribers.delete(slug);
    }
  };
}

export function broadcastToSlug(slug, event, payload, excludeClientId = null) {
  const set = subscribers.get(slug);
  if (!set || set.size === 0) return;

  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const entry of set) {
    if (excludeClientId && entry.clientId === excludeClientId) continue;
    try {
      entry.res.write(data);
    } catch {
      set.delete(entry);
    }
  }
}

export function getActiveViewerCount(slug) {
  const set = subscribers.get(slug);
  return set ? set.size : 0;
}
