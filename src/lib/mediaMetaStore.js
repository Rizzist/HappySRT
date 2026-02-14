import localforage from "localforage";

const store = localforage.createInstance({
  name: "happysrt",
  storeName: "media_meta",
});

function key(scope, threadId, clientFileId) {
  return `mediaMeta:v1:${scope}:${threadId}:${clientFileId}`;
}

export async function putLocalMediaMeta(scope, threadId, clientFileId, meta) {
  if (!scope || !threadId || !clientFileId) return;
  await store.setItem(key(scope, threadId, clientFileId), meta || {});
}

export async function getLocalMediaMeta(scope, threadId, clientFileId) {
  if (!scope || !threadId || !clientFileId) return null;
  return store.getItem(key(scope, threadId, clientFileId));
}
