import localforage from "localforage";

const store = localforage.createInstance({
  name: "happysrt",
  storeName: "media_index",
});

function key(scope, threadId, chatItemId) {
  return `mediaIndex:v1:${scope}:${threadId}:${chatItemId}`;
}

export async function putMediaIndex(scope, threadId, chatItemId, value) {
  if (!scope || !threadId || !chatItemId) return;
  await store.setItem(key(scope, threadId, chatItemId), value || {});
}

export async function getMediaIndex(scope, threadId, chatItemId) {
  if (!scope || !threadId || !chatItemId) return null;
  return store.getItem(key(scope, threadId, chatItemId));
}
