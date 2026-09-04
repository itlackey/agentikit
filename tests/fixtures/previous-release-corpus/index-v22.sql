-- Real-shaped v22 derived index essentials: parent entries plus the one
-- parent-level FTS population that 0.9.13 wrote before fragment storage.
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO index_meta VALUES ('version', '22');
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_ref TEXT NOT NULL UNIQUE,
  bundle_id TEXT NOT NULL, component_id TEXT NOT NULL, concept_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL, type TEXT NOT NULL, file_path TEXT NOT NULL,
  content_hash TEXT, document_json TEXT NOT NULL, search_text TEXT NOT NULL,
  derived_from TEXT
);
INSERT INTO entries (item_ref,bundle_id,component_id,concept_id,adapter_id,type,file_path,document_json,search_text)
VALUES ('stash//knowledge/v22-note','stash','stash','knowledge/v22-note','akm','knowledge','/fixture/v22-note.md',
 '{"name":"v22-note","type":"knowledge","description":"prior release parent row","content":"whole body evidence"}',
 'v22-note prior release parent row whole body evidence');
CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id UNINDEXED,name,description,tags,hints,content,tokenize='porter unicode61');
INSERT INTO entries_fts VALUES (1,'v22-note','prior release parent row','','','whole body evidence');
