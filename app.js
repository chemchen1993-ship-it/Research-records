const DB_NAME = "research-records-pwa";
const DB_VERSION = 1;
const STORE_RECORDS = "records";
const STORE_VERSIONS = "versions";
const STORE_DRAFTS = "drafts";
const STORE_SETTINGS = "settings";
const AUTOSAVE_DRAFT_KEY = "autosave";
const LAST_SELECTED_RECORD_KEY = "last-selected-record";
const AUTH_TOKEN_KEY = "auth-token";
const SYNC_ACCOUNT_KEY = "sync-account-id";
const NOTES_EDITOR_KEY = "__notes_body__";
const ENTRY_TYPE_REPORT = "experiment_report";
const ENTRY_TYPE_NOTES = "notes";
const API_BASE = "./api";
const SYNC_POLL_INTERVAL_MS = 10000;
const SERVER_UNAVAILABLE_MESSAGE = "Unable to reach the Research Records sync server. Start it locally or deploy it to a public host first.";

const SECTION_DEFINITIONS = [
  ["objective", "Objective"],
  ["conditions", "Conditions"],
  ["procedure", "Procedure"],
  ["results", "Results"],
  ["comments", "Comments"],
];
const SECTION_KEYS = SECTION_DEFINITIONS.map(([key]) => key);
const SECTION_LABELS = Object.fromEntries(SECTION_DEFINITIONS);
const LEFT_SECTION_KEYS = ["objective", "conditions", "procedure"];
const RIGHT_SECTION_KEYS = ["results", "comments"];
const DEFAULT_SECTION_HEIGHTS = {
  objective: 220,
  conditions: 220,
  procedure: 260,
  results: 220,
  comments: 220,
};
const DEFAULT_SECTION_HTML = Object.fromEntries(
  SECTION_KEYS.map((key) => [key, "<p></p>"]),
);

const state = {
  db: null,
  records: [],
  currentRecord: null,
  currentVersions: [],
  currentRecordPersisted: false,
  dirty: false,
  activeEditorKey: "objective",
  selectedAttachmentId: null,
  installPrompt: null,
  previewUrls: [],
  currentUser: null,
  authToken: null,
  syncTimerId: null,
  syncing: false,
  saving: false,
};

const elements = {
  workspace: document.getElementById("workspace"),
  authCard: document.getElementById("authCard"),
  authEmailInput: document.getElementById("authEmailInput"),
  authPasswordInput: document.getElementById("authPasswordInput"),
  registerButton: document.getElementById("registerButton"),
  loginButton: document.getElementById("loginButton"),
  logoutButton: document.getElementById("logoutButton"),
  authMessage: document.getElementById("authMessage"),
  accountPanel: document.getElementById("accountPanel"),
  accountEmail: document.getElementById("accountEmail"),
  searchInput: document.getElementById("searchInput"),
  recordTree: document.getElementById("recordTree"),
  recordCountLabel: document.getElementById("recordCountLabel"),
  panelTitle: document.getElementById("panelTitle"),
  panelMeta: document.getElementById("panelMeta"),
  statusBadge: document.getElementById("statusBadge"),
  reportTypeButton: document.getElementById("reportTypeButton"),
  noteTypeButton: document.getElementById("noteTypeButton"),
  dateFieldGroup: document.getElementById("dateFieldGroup"),
  tagsFieldGroup: document.getElementById("tagsFieldGroup"),
  dateInput: document.getElementById("dateInput"),
  projectInput: document.getElementById("projectInput"),
  titleInput: document.getElementById("titleInput"),
  tagsInput: document.getElementById("tagsInput"),
  reportToolbar: document.getElementById("reportToolbar"),
  notesToolbar: document.getElementById("notesToolbar"),
  reportLayout: document.getElementById("reportLayout"),
  notesLayout: document.getElementById("notesLayout"),
  leftSectionColumn: document.getElementById("leftSectionColumn"),
  rightSectionColumn: document.getElementById("rightSectionColumn"),
  notesEditor: document.getElementById("notesEditor"),
  restoreSectionSelect: document.getElementById("restoreSectionSelect"),
  restoreSectionButton: document.getElementById("restoreSectionButton"),
  insertTableButton: document.getElementById("insertTableButton"),
  insertInlineImageButton: document.getElementById("insertInlineImageButton"),
  insertNoteInlineImageButton: document.getElementById("insertNoteInlineImageButton"),
  attachmentList: document.getElementById("attachmentList"),
  addAttachmentButton: document.getElementById("addAttachmentButton"),
  renameAttachmentButton: document.getElementById("renameAttachmentButton"),
  previewAttachmentButton: document.getElementById("previewAttachmentButton"),
  downloadAttachmentButton: document.getElementById("downloadAttachmentButton"),
  removeAttachmentButton: document.getElementById("removeAttachmentButton"),
  saveButton: document.getElementById("saveButton"),
  exportPdfButton: document.getElementById("exportPdfButton"),
  duplicateButton: document.getElementById("duplicateButton"),
  versionButton: document.getElementById("versionButton"),
  deleteButton: document.getElementById("deleteButton"),
  newReportButton: document.getElementById("newReportButton"),
  newNoteButton: document.getElementById("newNoteButton"),
  installButton: document.getElementById("installButton"),
  iosInstallHint: document.getElementById("iosInstallHint"),
  attachmentInput: document.getElementById("attachmentInput"),
  inlineImageInput: document.getElementById("inlineImageInput"),
  noteInlineImageInput: document.getElementById("noteInlineImageInput"),
  previewDialog: document.getElementById("previewDialog"),
  previewTitle: document.getElementById("previewTitle"),
  previewBody: document.getElementById("previewBody"),
  closePreviewButton: document.getElementById("closePreviewButton"),
  versionDialog: document.getElementById("versionDialog"),
  versionList: document.getElementById("versionList"),
  versionPreview: document.getElementById("versionPreview"),
  closeVersionButton: document.getElementById("closeVersionButton"),
};

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
        const versionStore = db.createObjectStore(STORE_VERSIONS, { keyPath: "id" });
        versionStore.createIndex("recordId", "recordId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
  });
}

function accountScopedKey(baseKey) {
  return state.currentUser?.id ? `${baseKey}:${state.currentUser.id}` : baseKey;
}

function summarizeRecord(record) {
  const normalized = normalizeRecord(record);
  return {
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    project: normalized.project,
    tags: normalized.tags,
    experimentDate: normalized.experimentDate,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    searchSummary: String(record?.searchSummary || buildSearchSummary(normalized)),
    attachmentCount: Number(record?.attachmentCount || normalized.attachments.length) || 0,
  };
}

function prepareCachedRecord(record, options = {}) {
  const normalized = normalizeRecord(record);
  const summary = summarizeRecord(normalized);
  return {
    ...clonePlainRecord(normalized),
    ...summary,
    accountId: state.currentUser?.id || null,
    __summaryOnly: Boolean(options.summaryOnly),
  };
}

async function dbDeleteSetting(key) {
  const tx = state.db.transaction(STORE_SETTINGS, "readwrite");
  tx.objectStore(STORE_SETTINGS).delete(key);
  await transactionDone(tx);
}

async function cacheGetAllRecordEntries(accountId = state.currentUser?.id) {
  const tx = state.db.transaction(STORE_RECORDS, "readonly");
  const entries = await requestToPromise(tx.objectStore(STORE_RECORDS).getAll());
  await transactionDone(tx);
  return Array.isArray(entries)
    ? entries.filter((entry) => !entry.accountId || entry.accountId === accountId)
    : [];
}

async function cacheGetAllRecords() {
  const entries = await cacheGetAllRecordEntries();
  return entries.map((entry) => summarizeRecord(entry));
}

async function cacheGetRecordEntry(recordId) {
  const tx = state.db.transaction(STORE_RECORDS, "readonly");
  const entry = await requestToPromise(tx.objectStore(STORE_RECORDS).get(recordId));
  await transactionDone(tx);
  if (!entry) return null;
  if (entry.accountId && entry.accountId !== state.currentUser?.id) return null;
  return entry;
}

async function cachePutRecord(record, options = {}) {
  const tx = state.db.transaction(STORE_RECORDS, "readwrite");
  tx.objectStore(STORE_RECORDS).put(prepareCachedRecord(record, options));
  await transactionDone(tx);
}

async function cacheReplaceRecordSummaries(summaries) {
  const existingEntries = await cacheGetAllRecordEntries();
  const existingById = new Map(existingEntries.map((entry) => [entry.id, entry]));
  const keepIds = new Set(summaries.map((summary) => summary.id));

  const tx = state.db.transaction(STORE_RECORDS, "readwrite");
  const store = tx.objectStore(STORE_RECORDS);

  for (const entry of existingEntries) {
    if (!keepIds.has(entry.id)) {
      store.delete(entry.id);
    }
  }

  for (const summary of summaries) {
    const existing = existingById.get(summary.id);
    const canReuseFullRecord = existing && !existing.__summaryOnly && existing.updatedAt === summary.updatedAt;
    if (canReuseFullRecord) {
      store.put({
        ...existing,
        ...summary,
        accountId: state.currentUser?.id || null,
        __summaryOnly: false,
      });
      continue;
    }
    store.put({
      ...prepareCachedRecord(summary, { summaryOnly: true }),
      attachments: [],
      searchSummary: String(summary.searchSummary || ""),
      attachmentCount: Number(summary.attachmentCount || 0),
      __summaryOnly: true,
    });
  }

  await transactionDone(tx);
}

async function cacheDeleteRecord(recordId) {
  const tx = state.db.transaction([STORE_RECORDS, STORE_VERSIONS], "readwrite");
  tx.objectStore(STORE_RECORDS).delete(recordId);
  const versionStore = tx.objectStore(STORE_VERSIONS);
  const range = IDBKeyRange.only(recordId);
  const index = versionStore.index("recordId");
  const request = index.openCursor(range);
  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (!cursor.value.accountId || cursor.value.accountId === state.currentUser?.id) {
        cursor.delete();
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Failed to delete cached versions."));
  });
  await transactionDone(tx);
}

async function cacheGetVersions(recordId) {
  const tx = state.db.transaction(STORE_VERSIONS, "readonly");
  const entries = await requestToPromise(tx.objectStore(STORE_VERSIONS).index("recordId").getAll(recordId));
  await transactionDone(tx);
  return Array.isArray(entries)
    ? entries
        .filter((entry) => !entry.accountId || entry.accountId === state.currentUser?.id)
        .map((entry) => ({
          ...entry,
          snapshot: normalizeRecord(entry.snapshot),
        }))
        .sort((a, b) => Number(b.versionNo) - Number(a.versionNo))
    : [];
}

async function cachePutVersions(recordId, versions) {
  const existing = await cacheGetVersions(recordId);
  const tx = state.db.transaction(STORE_VERSIONS, "readwrite");
  const store = tx.objectStore(STORE_VERSIONS);
  for (const version of existing) {
    store.delete(version.id);
  }
  for (const version of versions) {
    store.put({
      id: String(version.id),
      recordId,
      versionNo: Number(version.versionNo),
      savedAt: String(version.savedAt),
      snapshot: clonePlainRecord(version.snapshot),
      accountId: state.currentUser?.id || null,
    });
  }
  await transactionDone(tx);
}

async function cacheClearSyncedData(accountId = state.currentUser?.id) {
  const recordEntries = await cacheGetAllRecordEntries(accountId);
  const tx = state.db.transaction([STORE_RECORDS, STORE_VERSIONS], "readwrite");
  const recordStore = tx.objectStore(STORE_RECORDS);
  const versionStore = tx.objectStore(STORE_VERSIONS);
  for (const entry of recordEntries) {
    recordStore.delete(entry.id);
  }
  const allVersions = await requestToPromise(versionStore.getAll());
  for (const entry of allVersions || []) {
    if (!entry.accountId || entry.accountId === accountId) {
      versionStore.delete(entry.id);
    }
  }
  await transactionDone(tx);
}

async function fetchRecordSummariesFromServer() {
  const payload = await apiFetchJson(`${API_BASE}/records`);
  return Array.isArray(payload?.records) ? payload.records.map((record) => summarizeRecord(record)) : [];
}

async function fetchRecordFromServer(recordId) {
  const payload = await apiFetchJson(`${API_BASE}/records/${encodeURIComponent(recordId)}`);
  const record = deserializeRecordFromApi(payload?.record);
  await cachePutRecord(record, { summaryOnly: false });
  return record;
}

async function fetchVersionsFromServer(recordId) {
  const payload = await apiFetchJson(`${API_BASE}/records/${encodeURIComponent(recordId)}/versions`, { allowNotFound: true });
  const versions = Array.isArray(payload?.versions) ? payload.versions.map((version) => ({
    ...version,
    snapshot: deserializeRecordFromApi(version.snapshot),
  })) : [];
  await cachePutVersions(recordId, versions);
  return versions.sort((a, b) => Number(b.versionNo) - Number(a.versionNo));
}

async function dbGetAllRecords() {
  return cacheGetAllRecords();
}

async function dbGetRecord(recordId, options = {}) {
  const cached = await cacheGetRecordEntry(recordId);
  if (cached && !cached.__summaryOnly && !options.forceRefresh) {
    return normalizeRecord(cached);
  }
  if (!state.currentUser) {
    if (!cached) {
      throw new Error("Sign in first.");
    }
    return normalizeRecord(cached);
  }
  return fetchRecordFromServer(recordId);
}

async function dbPutRecord(record) {
  if (!state.currentUser) {
    throw new Error("Sign in first.");
  }
  const payload = await serializeRecordForApi(record);
  const result = await apiFetchJson(`${API_BASE}/records`, {
    method: "POST",
    body: JSON.stringify({ record: payload }),
  });
  const savedRecord = deserializeRecordFromApi(result?.record);
  await cachePutRecord(savedRecord, { summaryOnly: false });
  await fetchVersionsFromServer(savedRecord.id);
  return savedRecord;
}

async function dbDeleteRecord(recordId) {
  if (!state.currentUser) {
    throw new Error("Sign in first.");
  }
  await apiFetchJson(`${API_BASE}/records/${encodeURIComponent(recordId)}`, {
    method: "DELETE",
  });
  await cacheDeleteRecord(recordId);
}

async function dbGetVersions(recordId, options = {}) {
  const cached = await cacheGetVersions(recordId);
  if (cached.length && !options.forceRefresh) {
    return cached;
  }
  if (!state.currentUser) {
    return cached;
  }
  return fetchVersionsFromServer(recordId);
}

async function dbPutVersion(version) {
  void version;
}

async function dbGetDraft() {
  const tx = state.db.transaction(STORE_DRAFTS, "readonly");
  const draft = await requestToPromise(tx.objectStore(STORE_DRAFTS).get(accountScopedKey(AUTOSAVE_DRAFT_KEY)));
  await transactionDone(tx);
  return draft || null;
}

async function dbPutDraft(snapshot) {
  const tx = state.db.transaction(STORE_DRAFTS, "readwrite");
  tx.objectStore(STORE_DRAFTS).put({
    id: accountScopedKey(AUTOSAVE_DRAFT_KEY),
    savedAt: new Date().toISOString(),
    snapshot: clonePlainRecord(snapshot),
  });
  await transactionDone(tx);
}

async function dbClearDraft() {
  const tx = state.db.transaction(STORE_DRAFTS, "readwrite");
  tx.objectStore(STORE_DRAFTS).delete(accountScopedKey(AUTOSAVE_DRAFT_KEY));
  await transactionDone(tx);
}

async function dbGetSetting(key) {
  const tx = state.db.transaction(STORE_SETTINGS, "readonly");
  const item = await requestToPromise(tx.objectStore(STORE_SETTINGS).get(key));
  await transactionDone(tx);
  return item ? item.value : null;
}

async function dbPutSetting(key, value) {
  const tx = state.db.transaction(STORE_SETTINGS, "readwrite");
  tx.objectStore(STORE_SETTINGS).put({ key, value });
  await transactionDone(tx);
}

async function apiFetchJson(url, options = {}) {
  const { allowNotFound = false, ...fetchOptions } = options;
  let response;
  try {
    const headers = {
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
      ...(fetchOptions.headers || {}),
    };
    response = await fetch(url, {
      cache: "no-store",
      headers,
      ...fetchOptions,
    });
  } catch (_error) {
    throw new Error(SERVER_UNAVAILABLE_MESSAGE);
  }

  if (response.status === 404 && allowNotFound) {
    return null;
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const errorPayload = await response.json();
      if (errorPayload?.error) message = errorPayload.error;
    } catch (_error) {
      // Ignore non-JSON error bodies.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return null;
}

function base64ToBlob(base64, type) {
  if (!base64) {
    return new Blob([], { type: type || "application/octet-stream" });
  }
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

async function serializeAttachmentForApi(attachment) {
  const file = attachment?.file instanceof Blob
    ? attachment.file
    : new Blob([], { type: attachment?.type || "application/octet-stream" });
  const dataUrl = await readFileAsDataUrl(file);
  return {
    id: String(attachment?.id || uuid()),
    name: String(attachment?.name || "Unnamed Attachment"),
    type: String(attachment?.type || file.type || "application/octet-stream"),
    size: Number(attachment?.size || file.size || 0),
    lastModified: Number(attachment?.lastModified || Date.now()),
    dataBase64: String(dataUrl).split(",", 2)[1] || "",
  };
}

function deserializeAttachmentFromApi(attachment) {
  return normalizeAttachment({
    id: attachment?.id,
    name: attachment?.name,
    type: attachment?.type,
    size: attachment?.size,
    lastModified: attachment?.lastModified,
    file: base64ToBlob(attachment?.dataBase64 || "", attachment?.type),
  });
}

async function serializeRecordForApi(record) {
  const normalized = clonePlainRecord(record);
  return {
    ...normalized,
    attachments: await Promise.all(normalized.attachments.map((attachment) => serializeAttachmentForApi(attachment))),
  };
}

function deserializeRecordFromApi(record) {
  return normalizeRecord({
    ...record,
    attachments: Array.isArray(record?.attachments)
      ? record.attachments.map((attachment) => deserializeAttachmentFromApi(attachment))
      : [],
  });
}

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatTimestamp(value) {
  if (!value) return "Not saved yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatFileSize(size) {
  if (!Number.isFinite(size)) return "Unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function stripHtml(html) {
  const temp = document.createElement("div");
  temp.innerHTML = html || "";
  return (temp.textContent || temp.innerText || "").replace(/\s+/g, " ").trim();
}

function sanitizeEditorHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "<p></p>";
  const allowedTags = new Set(["P", "BR", "DIV", "STRONG", "EM", "B", "I", "U", "SPAN", "UL", "OL", "LI", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "IMG", "A"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toRemove = [];
  while (walker.nextNode()) {
    const element = walker.currentNode;
    if (!allowedTags.has(element.tagName)) {
      toRemove.push(element);
      continue;
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (element.tagName === "IMG" && name === "src") continue;
      if (element.tagName === "A" && (name === "href" || name === "target" || name === "rel")) continue;
      if (name === "colspan" || name === "rowspan") continue;
      if (name === "style") continue;
      element.removeAttribute(attr.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }
  for (const element of toRemove) {
    element.replaceWith(...Array.from(element.childNodes));
  }
  return template.innerHTML.trim() || "<p></p>";
}

function normalizeVisibleSections(rawKeys) {
  const source = Array.isArray(rawKeys) ? rawKeys : SECTION_KEYS;
  const normalized = SECTION_KEYS.filter((key) => source.includes(key));
  return normalized.length ? normalized : ["objective"];
}

function normalizeSectionHeights(rawHeights) {
  const heights = {};
  for (const key of SECTION_KEYS) {
    const value = Number(rawHeights?.[key]);
    heights[key] = Number.isFinite(value) && value >= 140 ? Math.round(value) : DEFAULT_SECTION_HEIGHTS[key];
  }
  return heights;
}

function normalizeSectionContents(rawContents) {
  const contents = {};
  for (const key of SECTION_KEYS) {
    contents[key] = sanitizeEditorHtml(rawContents?.[key] || DEFAULT_SECTION_HTML[key]);
  }
  return contents;
}

function normalizeAttachment(attachment) {
  if (!attachment) return null;
  const file = attachment.file instanceof Blob ? attachment.file : new Blob([], { type: attachment.type || "application/octet-stream" });
  return {
    id: String(attachment.id || uuid()),
    name: String(attachment.name || "Unnamed Attachment"),
    type: String(attachment.type || file.type || "application/octet-stream"),
    size: Number(attachment.size || file.size || 0),
    lastModified: Number(attachment.lastModified || Date.now()),
    file,
  };
}

function cloneAttachment(attachment) {
  return {
    id: uuid(),
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    lastModified: attachment.lastModified,
    file: attachment.file,
  };
}

function normalizeRecord(record) {
  const type = record?.type === ENTRY_TYPE_NOTES ? ENTRY_TYPE_NOTES : ENTRY_TYPE_REPORT;
  return {
    id: String(record?.id || uuid()),
    type,
    title: String(record?.title || ""),
    project: String(record?.project || ""),
    tags: type === ENTRY_TYPE_NOTES ? "" : String(record?.tags || ""),
    experimentDate: type === ENTRY_TYPE_NOTES ? "" : String(record?.experimentDate || todayString()),
    createdAt: String(record?.createdAt || new Date().toISOString()),
    updatedAt: String(record?.updatedAt || record?.createdAt || new Date().toISOString()),
    visibleSectionKeys: type === ENTRY_TYPE_NOTES ? SECTION_KEYS : normalizeVisibleSections(record?.visibleSectionKeys),
    sectionContents: normalizeSectionContents(record?.sectionContents),
    sectionHeights: normalizeSectionHeights(record?.sectionHeights),
    noteContent: sanitizeEditorHtml(record?.noteContent || "<p></p>"),
    attachments: Array.isArray(record?.attachments) ? record.attachments.map(normalizeAttachment).filter(Boolean) : [],
    searchSummary: String(record?.searchSummary || ""),
    attachmentCount: Number(record?.attachmentCount || (Array.isArray(record?.attachments) ? record.attachments.length : 0)) || 0,
  };
}

function clonePlainRecord(record) {
  const normalized = normalizeRecord(record);
  return {
    ...normalized,
    attachments: normalized.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      lastModified: attachment.lastModified,
      file: attachment.file,
    })),
  };
}

function createEmptyRecord(type = ENTRY_TYPE_REPORT) {
  return normalizeRecord({
    id: uuid(),
    type,
    title: "",
    project: "",
    tags: "",
    experimentDate: type === ENTRY_TYPE_NOTES ? "" : todayString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    visibleSectionKeys: SECTION_KEYS,
    sectionContents: DEFAULT_SECTION_HTML,
    sectionHeights: DEFAULT_SECTION_HEIGHTS,
    noteContent: "<p></p>",
    attachments: [],
  });
}

function setCurrentEditorRecord(record, versions = [], persisted = false) {
  state.currentRecord = normalizeRecord(record);
  state.currentVersions = Array.isArray(versions) ? versions : [];
  state.currentRecordPersisted = Boolean(persisted);
  state.selectedAttachmentId = state.currentRecord.attachments[0]?.id || null;
  state.activeEditorKey = state.currentRecord.type === ENTRY_TYPE_NOTES ? NOTES_EDITOR_KEY : state.currentRecord.visibleSectionKeys[0];
}

function setStatus(text, mode = "ready") {
  elements.statusBadge.textContent = text;
  elements.statusBadge.dataset.mode = mode;
}

function markDirty(message = "Unsaved changes") {
  state.dirty = true;
  setStatus(message, "dirty");
}

function clearDirty(message = "Ready") {
  state.dirty = false;
  setStatus(message, "saved");
}

function setAuthMessage(message, mode = "info") {
  elements.authMessage.textContent = message;
  elements.authMessage.dataset.mode = mode;
}

function updateAuthShell() {
  const signedIn = Boolean(state.currentUser);
  elements.authCard.classList.toggle("hidden", signedIn);
  elements.workspace.classList.toggle("hidden", !signedIn);
  elements.accountPanel.classList.toggle("hidden", !signedIn);
  elements.accountEmail.textContent = state.currentUser?.email || "";
  if (!signedIn) {
    elements.recordTree.innerHTML = '<div class="empty-state">Sign in to load your synced records.</div>';
    elements.recordCountLabel.textContent = "0";
  }
}

function buildSearchSummary(record) {
  if (record?.searchSummary) return String(record.searchSummary);
  return record.type === ENTRY_TYPE_NOTES
    ? stripHtml(record.noteContent)
    : SECTION_KEYS.map((key) => stripHtml(record.sectionContents[key])).join(" ");
}

function matchesQuery(record, query) {
  if (!query) return true;
  const haystack = [record.title, record.project, record.tags, record.experimentDate, buildSearchSummary(record)].join(" ").toLowerCase();
  return haystack.includes(query);
}

function sortRecords(records) {
  return [...records].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function revokePreviewUrls() {
  for (const url of state.previewUrls) {
    URL.revokeObjectURL(url);
  }
  state.previewUrls = [];
}

function updatePanelMeta() {
  const record = state.currentRecord;
  elements.panelTitle.textContent = record.title.trim() || (record.type === ENTRY_TYPE_NOTES ? "Untitled Note" : "Untitled Report");
  elements.panelMeta.textContent = `Created ${formatTimestamp(record.createdAt)} | Updated ${formatTimestamp(record.updatedAt)}`;
}

function updateTypeButtons() {
  const isNotes = state.currentRecord.type === ENTRY_TYPE_NOTES;
  elements.reportTypeButton.classList.toggle("active", !isNotes);
  elements.noteTypeButton.classList.toggle("active", isNotes);
  elements.dateFieldGroup.classList.toggle("hidden", isNotes);
  elements.tagsFieldGroup.classList.toggle("hidden", isNotes);
  elements.reportToolbar.classList.toggle("hidden", isNotes);
  elements.notesToolbar.classList.toggle("hidden", !isNotes);
  elements.reportLayout.classList.toggle("hidden", isNotes);
  elements.notesLayout.classList.toggle("hidden", !isNotes);
}

function buildRecordButton(record) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record-item";
  if (state.currentRecord && record.id === state.currentRecord.id) {
    button.classList.add("active");
  }
  const metaText = record.type === ENTRY_TYPE_NOTES
    ? `Notes • Updated ${formatTimestamp(record.updatedAt)}`
    : `${record.experimentDate || "No date"} • ${record.tags ? `Tags: ${record.tags}` : "No tags"}`;
  button.innerHTML = `<span class="record-item-title">${escapeHtml(record.title.trim() || (record.type === ENTRY_TYPE_NOTES ? "Untitled Note" : "Untitled Report"))}</span><span class="record-item-meta">${escapeHtml(metaText)}</span>`;
  button.addEventListener("click", () => loadRecordIntoEditor(record.id));
  return button;
}

function renderRecordTree() {
  if (!state.currentUser) {
    elements.recordCountLabel.textContent = "0";
    elements.recordTree.innerHTML = '<div class="empty-state">Sign in to load your synced records.</div>';
    return;
  }
  const query = elements.searchInput.value.trim().toLowerCase();
  const filtered = sortRecords(state.records).filter((record) => matchesQuery(record, query));
  elements.recordCountLabel.textContent = `${filtered.length}`;
  elements.recordTree.innerHTML = "";
  if (!filtered.length) {
    elements.recordTree.innerHTML = '<div class="empty-state">No matching records.</div>';
    return;
  }

  const grouped = new Map();
  for (const record of filtered) {
    const projectName = record.project.trim() || "Unassigned Project";
    if (!grouped.has(projectName)) {
      grouped.set(projectName, { notes: [], dates: new Map() });
    }
    const bucket = grouped.get(projectName);
    if (record.type === ENTRY_TYPE_NOTES) {
      bucket.notes.push(record);
    } else {
      const dateKey = record.experimentDate || "No date";
      if (!bucket.dates.has(dateKey)) {
        bucket.dates.set(dateKey, []);
      }
      bucket.dates.get(dateKey).push(record);
    }
  }

  for (const [projectName, bucket] of grouped.entries()) {
    const projectDetails = document.createElement("details");
    projectDetails.className = "record-group";
    projectDetails.open = true;
    const projectCount = bucket.notes.length + [...bucket.dates.values()].reduce((sum, items) => sum + items.length, 0);
    projectDetails.innerHTML = `<summary>${escapeHtml(projectName)}<span class="group-meta">${projectCount} record(s)</span></summary>`;

    if (bucket.notes.length) {
      const notesDetails = document.createElement("details");
      notesDetails.className = "subgroup";
      notesDetails.open = true;
      notesDetails.innerHTML = `<summary>Notes<span class="group-meta">${bucket.notes.length} record(s)</span></summary>`;
      const items = document.createElement("div");
      items.className = "record-items";
      for (const record of bucket.notes) {
        items.appendChild(buildRecordButton(record));
      }
      notesDetails.appendChild(items);
      projectDetails.appendChild(notesDetails);
    }

    const sortedDates = [...bucket.dates.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [date, records] of sortedDates) {
      const dateDetails = document.createElement("details");
      dateDetails.className = "subgroup";
      dateDetails.open = true;
      dateDetails.innerHTML = `<summary>${escapeHtml(date)}<span class="group-meta">${records.length} record(s)</span></summary>`;
      const items = document.createElement("div");
      items.className = "record-items";
      for (const record of records) {
        items.appendChild(buildRecordButton(record));
      }
      dateDetails.appendChild(items);
      projectDetails.appendChild(dateDetails);
    }

    elements.recordTree.appendChild(projectDetails);
  }
}

function renderRestoreSectionOptions() {
  const hiddenSections = SECTION_KEYS.filter((key) => !state.currentRecord.visibleSectionKeys.includes(key));
  elements.restoreSectionSelect.innerHTML = "";
  if (!hiddenSections.length) {
    elements.restoreSectionSelect.innerHTML = '<option value="">No hidden sections</option>';
    elements.restoreSectionSelect.disabled = true;
    elements.restoreSectionButton.disabled = true;
    return;
  }
  for (const sectionKey of hiddenSections) {
    const option = document.createElement("option");
    option.value = sectionKey;
    option.textContent = SECTION_LABELS[sectionKey];
    elements.restoreSectionSelect.appendChild(option);
  }
  elements.restoreSectionSelect.disabled = false;
  elements.restoreSectionButton.disabled = false;
}

function buildSectionCard(sectionKey) {
  const section = document.createElement("section");
  section.className = "section-card";
  const canHide = state.currentRecord.visibleSectionKeys.length > 1;

  const titleRow = document.createElement("div");
  titleRow.className = "section-header";
  titleRow.innerHTML = `<h3 class="section-title">${escapeHtml(SECTION_LABELS[sectionKey])}</h3>`;
  const hideButton = document.createElement("button");
  hideButton.type = "button";
  hideButton.className = "ghost-button";
  hideButton.textContent = "Hide Section";
  hideButton.disabled = !canHide;
  hideButton.addEventListener("click", () => hideSection(sectionKey));
  titleRow.appendChild(hideButton);

  const info = document.createElement("p");
  info.className = "section-info";
  info.textContent = "Hide this section and restore it later.";

  const shell = document.createElement("div");
  shell.className = "section-shell";
  shell.style.height = `${state.currentRecord.sectionHeights[sectionKey]}px`;

  const editor = document.createElement("div");
  editor.className = "rich-editor section-editor";
  editor.contentEditable = "true";
  editor.spellcheck = true;
  editor.dataset.editorKey = sectionKey;
  editor.innerHTML = state.currentRecord.sectionContents[sectionKey];
  editor.addEventListener("input", () => markDirty());
  editor.addEventListener("focus", () => {
    state.activeEditorKey = sectionKey;
  });
  editor.addEventListener("paste", (event) => {
    handleEditorPaste(event, editor);
  });
  shell.appendChild(editor);

  const resizeHandle = document.createElement("button");
  resizeHandle.type = "button";
  resizeHandle.className = "resize-handle";
  resizeHandle.textContent = "Drag to resize / Double-click to reset";
  resizeHandle.addEventListener("pointerdown", (event) => startSectionResize(event, sectionKey, shell));
  resizeHandle.addEventListener("dblclick", () => resetSectionHeight(sectionKey, shell));

  section.append(titleRow, info, shell, resizeHandle);
  return section;
}

function renderReportLayout() {
  elements.leftSectionColumn.innerHTML = "";
  elements.rightSectionColumn.innerHTML = "";
  for (const sectionKey of LEFT_SECTION_KEYS) {
    if (state.currentRecord.visibleSectionKeys.includes(sectionKey)) {
      elements.leftSectionColumn.appendChild(buildSectionCard(sectionKey));
    }
  }
  for (const sectionKey of RIGHT_SECTION_KEYS) {
    if (state.currentRecord.visibleSectionKeys.includes(sectionKey)) {
      elements.rightSectionColumn.appendChild(buildSectionCard(sectionKey));
    }
  }
  renderRestoreSectionOptions();
}

function renderNotesLayout() {
  elements.notesEditor.innerHTML = state.currentRecord.noteContent;
}

function renderAttachmentList() {
  revokePreviewUrls();
  elements.attachmentList.innerHTML = "";
  if (!state.currentRecord.attachments.length) {
    elements.attachmentList.innerHTML = '<div class="empty-state">No attachments yet.</div>';
    state.selectedAttachmentId = null;
    return;
  }
  if (!state.currentRecord.attachments.some((attachment) => attachment.id === state.selectedAttachmentId)) {
    state.selectedAttachmentId = state.currentRecord.attachments[0].id;
  }

  for (const attachment of state.currentRecord.attachments) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "attachment-card";
    if (attachment.id === state.selectedAttachmentId) {
      card.classList.add("active");
    }
    card.addEventListener("click", () => {
      state.selectedAttachmentId = attachment.id;
      renderAttachmentList();
    });

    let thumb;
    if (attachment.type.startsWith("image/")) {
      thumb = document.createElement("img");
      thumb.className = "attachment-thumb";
      const url = URL.createObjectURL(attachment.file);
      state.previewUrls.push(url);
      thumb.src = url;
      thumb.alt = attachment.name;
    } else {
      thumb = document.createElement("div");
      thumb.className = "attachment-thumb";
      thumb.style.display = "grid";
      thumb.style.placeItems = "center";
      thumb.style.fontWeight = "700";
      thumb.style.color = "#64748b";
      thumb.textContent = attachment.name.split(".").pop()?.toUpperCase() || "FILE";
    }

    const meta = document.createElement("div");
    meta.className = "attachment-meta";
    meta.innerHTML = `<div class="attachment-name">${escapeHtml(attachment.name)}</div><div class="attachment-type">${escapeHtml(attachment.type || "Unknown type")}</div><div class="attachment-size">${formatFileSize(attachment.size)}</div>`;
    card.append(thumb, meta);
    elements.attachmentList.appendChild(card);
  }
}

function renderEditor() {
  updatePanelMeta();
  updateTypeButtons();
  elements.titleInput.value = state.currentRecord.title;
  elements.projectInput.value = state.currentRecord.project;
  elements.tagsInput.value = state.currentRecord.tags;
  elements.dateInput.value = state.currentRecord.experimentDate;
  if (state.currentRecord.type === ENTRY_TYPE_NOTES) {
    renderNotesLayout();
  } else {
    renderReportLayout();
  }
  renderAttachmentList();
}

function recordHasSavableContent(record) {
  const summary = buildSearchSummary(record);
  return Boolean(record.title.trim() || summary.trim() || record.attachments.length);
}

async function clearClientSession(message = "Signed out.") {
  const previousAccountId = state.currentUser?.id || await dbGetSetting(SYNC_ACCOUNT_KEY);
  state.authToken = null;
  state.currentUser = null;
  state.records = [];
  state.currentVersions = [];
  state.currentRecordPersisted = false;
  state.selectedAttachmentId = null;
  if (state.syncTimerId) {
    window.clearInterval(state.syncTimerId);
    state.syncTimerId = null;
  }
  await dbDeleteSetting(AUTH_TOKEN_KEY);
  await dbDeleteSetting(SYNC_ACCOUNT_KEY);
  if (previousAccountId) {
    await cacheClearSyncedData(previousAccountId);
  }
  setCurrentEditorRecord(createEmptyRecord(), [], false);
  renderEditor();
  renderRecordTree();
  updateAuthShell();
  setAuthMessage(message, "info");
  clearDirty("Signed out");
}

async function applyAuthenticatedSession(user, session = null) {
  const previousAccountId = await dbGetSetting(SYNC_ACCOUNT_KEY);
  if (session?.token) {
    state.authToken = session.token;
    await dbPutSetting(AUTH_TOKEN_KEY, session.token);
  }
  if (previousAccountId && previousAccountId !== user.id) {
    await cacheClearSyncedData(previousAccountId);
  }
  state.currentUser = user;
  await dbPutSetting(SYNC_ACCOUNT_KEY, user.id);
  updateAuthShell();
  setAuthMessage(`Signed in as ${user.email}.`, "success");
  await bootInitialRecord();
  await syncFromServer({ forceReloadCurrent: true });
  setupSyncPolling();
}

async function handleAuthAction(mode) {
  const email = elements.authEmailInput.value.trim();
  const password = elements.authPasswordInput.value;
  if (!email) {
    setAuthMessage("Enter your email address.", "error");
    elements.authEmailInput.focus();
    return;
  }
  if (password.length < 8) {
    setAuthMessage("Password must be at least 8 characters.", "error");
    elements.authPasswordInput.focus();
    return;
  }
  const button = mode === "register" ? elements.registerButton : elements.loginButton;
  const originalLabel = button.textContent;
  button.disabled = true;
  setAuthMessage(mode === "register" ? "Creating account..." : "Signing in...", "info");
  try {
    const payload = await apiFetchJson(`${API_BASE}/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    elements.authPasswordInput.value = "";
    await applyAuthenticatedSession(payload.user, payload.session);
  } catch (error) {
    setAuthMessage(error?.message || "Authentication failed.", "error");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function logoutCurrentUser() {
  try {
    await apiFetchJson(`${API_BASE}/auth/logout`, {
      method: "POST",
      suppressAuthReset: true,
    });
  } catch (_error) {
    // Ignore network errors during logout; local session still needs to be cleared.
  }
  await clearClientSession("Signed out. Sign in again on this or another device anytime.");
}

function collectCurrentRecordFromDom() {
  const record = clonePlainRecord(state.currentRecord || createEmptyRecord());
  record.type = state.currentRecord.type;
  record.title = elements.titleInput.value.trim();
  record.project = elements.projectInput.value.trim();
  record.tags = record.type === ENTRY_TYPE_NOTES ? "" : elements.tagsInput.value.trim();
  record.experimentDate = record.type === ENTRY_TYPE_NOTES ? "" : (elements.dateInput.value || todayString());
  record.updatedAt = new Date().toISOString();

  if (record.type === ENTRY_TYPE_NOTES) {
    record.noteContent = sanitizeEditorHtml(elements.notesEditor.innerHTML);
    record.visibleSectionKeys = SECTION_KEYS;
  } else {
    for (const sectionKey of SECTION_KEYS) {
      const editor = document.querySelector(`.rich-editor[data-editor-key="${sectionKey}"]`);
      const shell = editor?.closest(".section-shell");
      if (editor) {
        record.sectionContents[sectionKey] = sanitizeEditorHtml(editor.innerHTML);
      }
      if (shell) {
        const height = Number.parseFloat(shell.style.height);
        if (Number.isFinite(height) && height >= 140) {
          record.sectionHeights[sectionKey] = Math.round(height);
        }
      }
    }
  }
  return normalizeRecord(record);
}

function hideSection(sectionKey) {
  if (state.currentRecord.visibleSectionKeys.length <= 1) {
    window.alert("At least one section must stay visible.");
    return;
  }
  const record = collectCurrentRecordFromDom();
  record.visibleSectionKeys = record.visibleSectionKeys.filter((key) => key !== sectionKey);
  state.currentRecord = record;
  renderEditor();
  markDirty(`${SECTION_LABELS[sectionKey]} hidden`);
}

function restoreSection() {
  const sectionKey = elements.restoreSectionSelect.value;
  if (!sectionKey) return;
  const record = collectCurrentRecordFromDom();
  if (!record.visibleSectionKeys.includes(sectionKey)) {
    record.visibleSectionKeys = SECTION_KEYS.filter((key) => key === sectionKey || record.visibleSectionKeys.includes(key));
  }
  state.currentRecord = record;
  renderEditor();
  markDirty(`${SECTION_LABELS[sectionKey]} restored`);
}

function startSectionResize(event, sectionKey, shell) {
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = shell.getBoundingClientRect().height;
  function onMove(moveEvent) {
    const nextHeight = Math.max(140, Math.round(startHeight + moveEvent.clientY - startY));
    shell.style.height = `${nextHeight}px`;
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.currentRecord.sectionHeights[sectionKey] = Math.max(140, Math.round(parseFloat(shell.style.height)));
    markDirty(`${SECTION_LABELS[sectionKey]} height changed`);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function resetSectionHeight(sectionKey, shell) {
  shell.style.height = `${DEFAULT_SECTION_HEIGHTS[sectionKey]}px`;
  state.currentRecord.sectionHeights[sectionKey] = DEFAULT_SECTION_HEIGHTS[sectionKey];
  markDirty(`${SECTION_LABELS[sectionKey]} height reset`);
}

function ensureEditorNotEmpty(editor) {
  if (!editor.innerHTML.trim()) {
    editor.innerHTML = "<p></p>";
  }
}

function insertHtmlAtCursor(editor, html) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode)) {
    editor.insertAdjacentHTML("beforeend", html);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const temp = document.createElement("div");
  temp.innerHTML = html;
  const fragment = document.createDocumentFragment();
  let node;
  let lastNode = null;
  while ((node = temp.firstChild)) {
    lastNode = fragment.appendChild(node);
  }
  range.insertNode(fragment);
  if (lastNode) {
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function insertInlineImages(editor, files) {
  ensureEditorNotEmpty(editor);
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const dataUrl = await readFileAsDataUrl(file);
    insertHtmlAtCursor(editor, `<p><img src="${dataUrl}" alt="${escapeHtml(file.name)}"></p><p></p>`);
  }
  markDirty("Inline image inserted");
}

async function handleEditorPaste(event, editor) {
  const items = [...(event.clipboardData?.items || [])];
  const imageFiles = items
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!imageFiles.length) return;
  event.preventDefault();
  await insertInlineImages(editor, imageFiles);
}

function insertTable() {
  if (state.currentRecord.type === ENTRY_TYPE_NOTES) return;
  const editor = document.querySelector(`.rich-editor[data-editor-key="${state.activeEditorKey}"]`) || document.querySelector(".rich-editor[data-editor-key]");
  if (!editor) return;
  const rows = Math.max(1, Number.parseInt(window.prompt("Rows", "3") || "3", 10) || 3);
  const cols = Math.max(1, Number.parseInt(window.prompt("Columns", "3") || "3", 10) || 3);
  const rowHtml = Array.from({ length: rows }, () => `<tr>${Array.from({ length: cols }, () => "<td>&nbsp;</td>").join("")}</tr>`).join("");
  insertHtmlAtCursor(editor, `<table><tbody>${rowHtml}</tbody></table><p></p>`);
  markDirty("Table inserted");
}

function updateCurrentRecordType(type) {
  const record = collectCurrentRecordFromDom();
  record.type = type;
  if (type === ENTRY_TYPE_NOTES) {
    record.experimentDate = "";
    record.tags = "";
    state.activeEditorKey = NOTES_EDITOR_KEY;
  } else {
    record.experimentDate = record.experimentDate || todayString();
    state.activeEditorKey = record.visibleSectionKeys[0] || "objective";
  }
  state.currentRecord = normalizeRecord(record);
  renderEditor();
  markDirty("Record type changed");
}

async function addAttachments(files) {
  const attachments = [...files].map((file) => ({
    id: uuid(),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size || 0,
    lastModified: file.lastModified || Date.now(),
    file,
  }));
  state.currentRecord.attachments.push(...attachments);
  state.selectedAttachmentId = attachments[0]?.id || state.selectedAttachmentId;
  renderAttachmentList();
  markDirty("Attachment added");
}

function getSelectedAttachment() {
  return state.currentRecord.attachments.find((attachment) => attachment.id === state.selectedAttachmentId) || null;
}

function renameAttachment() {
  const attachment = getSelectedAttachment();
  if (!attachment) {
    window.alert("Select an attachment first.");
    return;
  }
  const nextName = window.prompt("Rename attachment", attachment.name);
  if (!nextName) return;
  attachment.name = nextName.trim() || attachment.name;
  renderAttachmentList();
  markDirty("Attachment renamed");
}

function removeAttachment() {
  const attachment = getSelectedAttachment();
  if (!attachment) {
    window.alert("Select an attachment first.");
    return;
  }
  state.currentRecord.attachments = state.currentRecord.attachments.filter((item) => item.id !== attachment.id);
  state.selectedAttachmentId = state.currentRecord.attachments[0]?.id || null;
  renderAttachmentList();
  markDirty("Attachment removed");
}

function closePreviewDialog() {
  elements.previewDialog.close();
  elements.previewBody.innerHTML = "";
}

function previewAttachment() {
  const attachment = getSelectedAttachment();
  if (!attachment) {
    window.alert("Select an attachment first.");
    return;
  }
  elements.previewTitle.textContent = attachment.name;
  elements.previewBody.innerHTML = "";
  if (attachment.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "preview-image";
    const url = URL.createObjectURL(attachment.file);
    state.previewUrls.push(url);
    img.src = url;
    img.alt = attachment.name;
    elements.previewBody.appendChild(img);
  } else if (attachment.type === "application/pdf") {
    const iframe = document.createElement("iframe");
    iframe.style.width = "100%";
    iframe.style.height = "68vh";
    iframe.style.border = "1px solid #d9e1ec";
    const url = URL.createObjectURL(attachment.file);
    state.previewUrls.push(url);
    iframe.src = url;
    elements.previewBody.appendChild(iframe);
  } else {
    elements.previewBody.innerHTML = `<div class="empty-state">${escapeHtml(attachment.name)} cannot be previewed inline here. Use Download to open it in another app.</div>`;
  }
  elements.previewDialog.showModal();
}

function downloadAttachment() {
  const attachment = getSelectedAttachment();
  if (!attachment) {
    window.alert("Select an attachment first.");
    return;
  }
  const url = URL.createObjectURL(attachment.file);
  state.previewUrls.push(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.click();
}

function buildVersionPreviewHtml(snapshot) {
  const record = normalizeRecord(snapshot);
  const header = `
    <h3>${escapeHtml(record.title || (record.type === ENTRY_TYPE_NOTES ? "Untitled Note" : "Untitled Report"))}</h3>
    <p><strong>Type:</strong> ${record.type === ENTRY_TYPE_NOTES ? "Notes" : "Experiment Report"}</p>
    <p><strong>Project:</strong> ${escapeHtml(record.project || "Not set")}</p>
    <p><strong>Date:</strong> ${escapeHtml(record.experimentDate || "N/A")}</p>
    <p><strong>Tags:</strong> ${escapeHtml(record.tags || "N/A")}</p>
  `;
  if (record.type === ENTRY_TYPE_NOTES) {
    return `${header}<hr><div>${record.noteContent}</div>`;
  }
  return `${header}<hr>${record.visibleSectionKeys.map((sectionKey) => `<section><h4>${escapeHtml(SECTION_LABELS[sectionKey])}</h4><div>${record.sectionContents[sectionKey]}</div></section>`).join("")}`;
}

function openVersionHistory() {
  elements.versionList.innerHTML = "";
  elements.versionPreview.innerHTML = "";
  if (!state.currentVersions.length) {
    elements.versionList.innerHTML = '<div class="empty-state">No saved versions yet.</div>';
    elements.versionPreview.innerHTML = '<div class="empty-state">Save the record first to create version history.</div>';
    elements.versionDialog.showModal();
    return;
  }
  for (const version of state.currentVersions) {
    const item = document.createElement("div");
    item.className = "version-item";
    item.innerHTML = `<div><strong>Version ${version.versionNo}</strong></div><div class="muted-text">${escapeHtml(formatTimestamp(version.savedAt))}</div>`;
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "secondary-button";
    previewButton.textContent = "Preview";
    previewButton.addEventListener("click", () => {
      elements.versionPreview.innerHTML = buildVersionPreviewHtml(version.snapshot);
    });
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "secondary-button";
    restoreButton.textContent = "Restore to Editor";
    restoreButton.addEventListener("click", () => {
      if (!window.confirm(`Restore version ${version.versionNo} to the editor?`)) return;
      state.currentRecord = normalizeRecord(version.snapshot);
      state.activeEditorKey = state.currentRecord.type === ENTRY_TYPE_NOTES ? NOTES_EDITOR_KEY : state.currentRecord.visibleSectionKeys[0];
      renderEditor();
      markDirty(`Restored version ${version.versionNo}`);
      elements.versionDialog.close();
    });
    item.append(previewButton, restoreButton);
    elements.versionList.appendChild(item);
  }
  elements.versionPreview.innerHTML = buildVersionPreviewHtml(state.currentVersions[0].snapshot);
  elements.versionDialog.showModal();
}

function buildPrintHtml(record) {
  const normalized = normalizeRecord(record);
  const sectionBlocks = normalized.type === ENTRY_TYPE_NOTES
    ? `<section class="print-block"><h3>Notes</h3><div>${normalized.noteContent}</div></section>`
    : normalized.visibleSectionKeys.map((sectionKey) => `<section class="print-block"><h3>${escapeHtml(SECTION_LABELS[sectionKey])}</h3><div>${normalized.sectionContents[sectionKey]}</div></section>`).join("");

  const attachmentsHtml = normalized.attachments.length
    ? normalized.attachments.map((attachment) => {
        if (attachment.type.startsWith("image/")) {
          const url = URL.createObjectURL(attachment.file);
          state.previewUrls.push(url);
          return `<div class="print-attachment"><h4>${escapeHtml(attachment.name)}</h4><img src="${url}" alt="${escapeHtml(attachment.name)}"></div>`;
        }
        return `<div class="print-attachment"><h4>${escapeHtml(attachment.name)}</h4><p>${escapeHtml(attachment.type || "Attachment")}</p></div>`;
      }).join("")
    : "<p>No attachments.</p>";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(normalized.title || "Research Record")}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:28px;color:#111827;line-height:1.6}h1,h2,h3,h4{margin-bottom:8px}.meta{color:#475467;margin-bottom:20px}.print-block{margin-bottom:22px;page-break-inside:avoid}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #cbd5e1;padding:8px}img{max-width:100%;height:auto;border-radius:10px}.print-attachment{margin-bottom:20px;page-break-inside:avoid}</style></head><body><h1>${escapeHtml(normalized.title || (normalized.type === ENTRY_TYPE_NOTES ? "Untitled Note" : "Untitled Report"))}</h1><div class="meta"><div><strong>Type:</strong> ${normalized.type === ENTRY_TYPE_NOTES ? "Notes" : "Experiment Report"}</div><div><strong>Project:</strong> ${escapeHtml(normalized.project || "Not set")}</div><div><strong>Date:</strong> ${escapeHtml(normalized.experimentDate || "N/A")}</div><div><strong>Tags:</strong> ${escapeHtml(normalized.tags || "N/A")}</div><div><strong>Updated:</strong> ${escapeHtml(formatTimestamp(normalized.updatedAt))}</div></div>${sectionBlocks}<section class="print-block"><h2>Attachments</h2>${attachmentsHtml}</section></body></html>`;
}

function exportPdf() {
  const record = collectCurrentRecordFromDom();
  const printWindow = window.open("", "_blank", "noopener,noreferrer");
  if (!printWindow) {
    window.alert("Allow popups first so the print view can open.");
    return;
  }
  printWindow.document.open();
  printWindow.document.write(buildPrintHtml(record));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
  }, 500);
}

async function saveCurrentRecord(options = {}) {
  if (state.saving) return;
  if (!state.currentUser) {
    window.alert("Sign in first so this record can sync to the cloud.");
    return;
  }

  const { silent = false, statusMessage = "Saved" } = options;
  const record = collectCurrentRecordFromDom();
  if (!recordHasSavableContent(record)) {
    if (!silent) {
      window.alert("Enter content or add attachments before saving.");
    }
    return;
  }

  record.updatedAt = new Date().toISOString();
  if (!record.createdAt) record.createdAt = record.updatedAt;
  if (record.type !== ENTRY_TYPE_NOTES && !record.experimentDate) {
    record.experimentDate = todayString();
  }

  state.saving = true;
  setStatus(silent ? "Syncing..." : "Saving...", "draft");
  try {
    const savedRecord = await dbPutRecord(record);
    await dbPutSetting(accountScopedKey(LAST_SELECTED_RECORD_KEY), savedRecord.id);
    await dbClearDraft();
    const versions = await dbGetVersions(savedRecord.id, { forceRefresh: true });
    state.records = await dbGetAllRecords();
    setCurrentEditorRecord(savedRecord, versions, true);
    renderEditor();
    renderRecordTree();
    clearDirty(statusMessage);
  } catch (error) {
    setStatus("Sync failed", "error");
    if (!silent) {
      window.alert(error?.message || "Failed to save the record.");
    }
    throw error;
  } finally {
    state.saving = false;
  }
}

function duplicateCurrentRecord() {
  const current = collectCurrentRecordFromDom();
  const duplicate = clonePlainRecord(current);
  duplicate.id = uuid();
  duplicate.createdAt = new Date().toISOString();
  duplicate.updatedAt = duplicate.createdAt;
  duplicate.title = duplicate.title ? `${duplicate.title} (Copy)` : "";
  duplicate.attachments = duplicate.attachments.map(cloneAttachment);
  setCurrentEditorRecord(duplicate, [], false);
  renderEditor();
  renderRecordTree();
  markDirty("Duplicated into a new draft");
}

async function deleteCurrentRecord() {
  const existing = state.records.find((record) => record.id === state.currentRecord.id);
  if (!existing) {
    if (!window.confirm("Discard the current unsaved draft?")) return;
    setCurrentEditorRecord(createEmptyRecord(), [], false);
    renderEditor();
    renderRecordTree();
    clearDirty("Ready");
    return;
  }
  if (!window.confirm("Delete the current record?")) return;
  await dbDeleteRecord(existing.id);
  await dbClearDraft();
  state.records = await dbGetAllRecords();
  if (state.records.length) {
    const fallback = await dbGetRecord(state.records[0].id);
    const versions = await dbGetVersions(fallback.id);
    setCurrentEditorRecord(fallback, versions, true);
  } else {
    setCurrentEditorRecord(createEmptyRecord(), [], false);
  }
  renderEditor();
  renderRecordTree();
  clearDirty("Deleted");
}

async function loadRecordIntoEditor(recordId) {
  const record = await dbGetRecord(recordId);
  const versions = await dbGetVersions(recordId);
  setCurrentEditorRecord(record, versions, true);
  renderEditor();
  renderRecordTree();
  clearDirty("Loaded");
  await dbPutSetting(accountScopedKey(LAST_SELECTED_RECORD_KEY), recordId);
}

async function maybeRestoreDraft() {
  const draft = await dbGetDraft();
  if (!draft?.snapshot) return false;
  const draftRecord = normalizeRecord(draft.snapshot);
  const persisted = state.records.some((record) => record.id === draftRecord.id);
  const versions = persisted && draftRecord.id ? await dbGetVersions(draftRecord.id) : [];
  setCurrentEditorRecord(draftRecord, versions, persisted);
  renderEditor();
  markDirty("Draft restored");
  return true;
}

async function saveDraft(silent = false) {
  if (!state.currentRecord || !state.dirty) return;
  const snapshot = collectCurrentRecordFromDom();
  await dbPutDraft(snapshot);
  if (!silent) setStatus("Draft saved", "draft");
}

async function bootInitialRecord() {
  state.records = await dbGetAllRecords();
  if (await maybeRestoreDraft()) {
    renderRecordTree();
    return;
  }
  const lastSelected = await dbGetSetting(accountScopedKey(LAST_SELECTED_RECORD_KEY));
  const preferred = state.records.find((record) => record.id === lastSelected) || state.records[0] || null;
  if (preferred?.id) {
    const fullRecord = await dbGetRecord(preferred.id);
    const versions = await dbGetVersions(preferred.id);
    setCurrentEditorRecord(fullRecord, versions, true);
  } else {
    setCurrentEditorRecord(createEmptyRecord(), [], false);
  }
  renderEditor();
  renderRecordTree();
  clearDirty("Ready");
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch (_error) {
    // Ignore preview-only failures.
  }
}

function detectIosInstallFlow() {
  const ua = navigator.userAgent || navigator.vendor || "";
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  elements.iosInstallHint.classList.toggle("hidden", !(isIos && !isStandalone));
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    elements.installButton.hidden = false;
  });
  elements.installButton.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    elements.installButton.hidden = true;
  });
}

async function syncFromServer({ forceReloadCurrent = false } = {}) {
  if (!state.currentUser || state.syncing) {
    return;
  }
  state.syncing = true;
  try {
    const summaries = await fetchRecordSummariesFromServer();
    await cacheReplaceRecordSummaries(summaries);
    state.records = await dbGetAllRecords();

    if (!state.currentRecord) {
      renderRecordTree();
      return;
    }

    if (state.dirty) {
      renderRecordTree();
      return;
    }

    const currentSummary = state.records.find((record) => record.id === state.currentRecord.id);
    if (!state.currentRecordPersisted) {
      renderRecordTree();
      return;
    }

    if (!currentSummary) {
      if (state.records.length) {
        const fallback = await dbGetRecord(state.records[0].id, { forceRefresh: true });
        const versions = await dbGetVersions(fallback.id, { forceRefresh: true });
        setCurrentEditorRecord(fallback, versions, true);
      } else {
        setCurrentEditorRecord(createEmptyRecord(), [], false);
      }
      renderEditor();
      renderRecordTree();
      clearDirty("Synced");
      return;
    }

    if (forceReloadCurrent || currentSummary.updatedAt !== state.currentRecord.updatedAt) {
      const fullRecord = await dbGetRecord(currentSummary.id, { forceRefresh: true });
      const versions = await dbGetVersions(currentSummary.id, { forceRefresh: true });
      setCurrentEditorRecord(fullRecord, versions, true);
      renderEditor();
      renderRecordTree();
      clearDirty(forceReloadCurrent ? "Ready" : "Synced");
      return;
    }

    renderRecordTree();
  } finally {
    state.syncing = false;
  }
}

function setupSyncPolling() {
  if (state.syncTimerId) {
    return;
  }
  state.syncTimerId = window.setInterval(() => {
    if (document.hidden) return;
    syncFromServer().catch((error) => {
      console.warn("Research Records sync poll failed.", error);
    });
  }, SYNC_POLL_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    syncFromServer().catch((error) => {
      console.warn("Research Records sync refresh failed.", error);
    });
  });
}

function bindInputs() {
  for (const input of [elements.titleInput, elements.projectInput, elements.tagsInput, elements.dateInput]) {
    input.addEventListener("input", () => markDirty());
  }
  for (const input of [elements.authEmailInput, elements.authPasswordInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleAuthAction("login");
      }
    });
  }
  elements.notesEditor.addEventListener("input", () => markDirty());
  elements.notesEditor.addEventListener("focus", () => {
    state.activeEditorKey = NOTES_EDITOR_KEY;
  });
  elements.notesEditor.addEventListener("paste", (event) => {
    handleEditorPaste(event, elements.notesEditor);
  });
}

function bindButtons() {
  elements.registerButton.addEventListener("click", () => handleAuthAction("register"));
  elements.loginButton.addEventListener("click", () => handleAuthAction("login"));
  elements.logoutButton.addEventListener("click", logoutCurrentUser);
  elements.newReportButton.addEventListener("click", () => {
    setCurrentEditorRecord(createEmptyRecord(ENTRY_TYPE_REPORT), [], false);
    renderEditor();
    renderRecordTree();
    clearDirty("Ready");
  });
  elements.newNoteButton.addEventListener("click", () => {
    setCurrentEditorRecord(createEmptyRecord(ENTRY_TYPE_NOTES), [], false);
    renderEditor();
    renderRecordTree();
    clearDirty("Ready");
  });
  elements.reportTypeButton.addEventListener("click", () => updateCurrentRecordType(ENTRY_TYPE_REPORT));
  elements.noteTypeButton.addEventListener("click", () => updateCurrentRecordType(ENTRY_TYPE_NOTES));
  elements.searchInput.addEventListener("input", renderRecordTree);
  elements.restoreSectionButton.addEventListener("click", restoreSection);
  elements.insertTableButton.addEventListener("click", insertTable);
  elements.insertInlineImageButton.addEventListener("click", () => elements.inlineImageInput.click());
  elements.insertNoteInlineImageButton.addEventListener("click", () => elements.noteInlineImageInput.click());
  elements.addAttachmentButton.addEventListener("click", () => elements.attachmentInput.click());
  elements.renameAttachmentButton.addEventListener("click", renameAttachment);
  elements.previewAttachmentButton.addEventListener("click", previewAttachment);
  elements.downloadAttachmentButton.addEventListener("click", downloadAttachment);
  elements.removeAttachmentButton.addEventListener("click", removeAttachment);
  elements.saveButton.addEventListener("click", saveCurrentRecord);
  elements.exportPdfButton.addEventListener("click", exportPdf);
  elements.duplicateButton.addEventListener("click", duplicateCurrentRecord);
  elements.versionButton.addEventListener("click", openVersionHistory);
  elements.deleteButton.addEventListener("click", deleteCurrentRecord);
  elements.closePreviewButton.addEventListener("click", closePreviewDialog);
  elements.closeVersionButton.addEventListener("click", () => elements.versionDialog.close());

  elements.attachmentInput.addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    if (files.length) await addAttachments(files);
    event.target.value = "";
  });
  elements.inlineImageInput.addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    const editor = document.querySelector(`.rich-editor[data-editor-key="${state.activeEditorKey}"]`) || elements.notesEditor;
    if (editor && files.length) await insertInlineImages(editor, files);
    event.target.value = "";
  });
  elements.noteInlineImageInput.addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    if (files.length) await insertInlineImages(elements.notesEditor, files);
    event.target.value = "";
  });
}

function setupAutosave() {
  window.setInterval(() => {
    saveDraft(true).catch(() => {});
    if (state.currentUser && state.dirty && recordHasSavableContent(collectCurrentRecordFromDom())) {
      saveCurrentRecord({ silent: true, statusMessage: "Synced" }).catch(() => {});
    }
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      saveDraft(true).catch(() => {});
      if (state.currentUser && state.dirty && recordHasSavableContent(collectCurrentRecordFromDom())) {
        saveCurrentRecord({ silent: true, statusMessage: "Synced" }).catch(() => {});
      }
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function init() {
  bindInputs();
  bindButtons();
  detectIosInstallFlow();
  setupInstallPrompt();
  setupAutosave();
  await registerServiceWorker();
  state.db = await openDatabase();
  updateAuthShell();
  setCurrentEditorRecord(createEmptyRecord(), [], false);
  renderEditor();

  const savedToken = await dbGetSetting(AUTH_TOKEN_KEY);
  if (savedToken) {
    state.authToken = savedToken;
    try {
      const payload = await apiFetchJson(`${API_BASE}/auth/me`);
      await applyAuthenticatedSession(payload.user);
    } catch (_error) {
      await clearClientSession("Session expired. Sign in again to continue syncing.");
    }
  } else {
    setAuthMessage("Create an account or sign in with an existing one.", "info");
  }
}

init().catch((error) => {
  console.error(error);
  elements.recordTree.innerHTML = `<div class="empty-state">Failed to start the PWA: ${escapeHtml(error?.message || String(error))}</div>`;
  setStatus("Startup failed", "error");
});
