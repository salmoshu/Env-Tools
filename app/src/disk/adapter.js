const listeners = new Map();
let cursor = 0;
let timer = 0;
let polling = false;

function argumentName(key) {
  return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function normalizeArgs(args) {
  return Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [argumentName(key), value]));
}

async function pollEvents() {
  if (polling) return;
  polling = true;
  try {
    const result = await window.api.diskEvents(cursor);
    cursor = result?.next ?? cursor;
    for (const event of result?.events || []) {
      for (const callback of listeners.get(event.event) || []) {
        callback(event);
      }
    }
  } catch {
    await new Promise(resolve => setTimeout(resolve, 800));
  } finally {
    polling = false;
    if (listeners.size) timer = window.setTimeout(pollEvents, 180);
  }
}

export async function listen(name, callback) {
  let callbacks = listeners.get(name);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(name, callbacks);
  }
  callbacks.add(callback);
  clearTimeout(timer);
  timer = window.setTimeout(pollEvents, 0);
  return () => {
    callbacks.delete(callback);
    if (!callbacks.size) listeners.delete(name);
    if (!listeners.size) clearTimeout(timer);
  };
}

export async function invoke(command, args = {}) {
  switch (command) {
    case "check_access":
      return { needs_prompt: false };
    case "open_access_settings":
      return window.api.diskOpenAccessSettings();
    case "open_url":
      return window.api.diskOpenUrl(args.url);
    case "reveal_path":
      return window.api.diskReveal(args.path);
    case "gadget_set":
      return window.api.diskGadgetSet(args.enabled, args.mode);
    case "gadget_fit":
      return window.api.diskGadgetFit(args.width, args.height);
    case "gadget_open_main":
      return window.api.diskGadgetOpenMain();
    default:
      return window.api.diskInvoke(command, normalizeArgs(args));
  }
}

export function getCurrentWindow() {
  return {
    startDragging: async () => window.api.diskGadgetStartDrag?.(),
  };
}
