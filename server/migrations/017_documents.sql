ALTER TABLE accounting_documents RENAME TO documents;
DROP INDEX IF EXISTS accounting_documents_created;
DROP INDEX IF EXISTS accounting_documents_category_created;
CREATE INDEX documents_created ON documents(created_at);
CREATE INDEX documents_category_created ON documents(category, created_at);

INSERT OR IGNORE INTO user_permissions(user_id, permission_key, granted)
SELECT user_id, 'documents.access', granted FROM user_permissions WHERE permission_key = 'accounting.access';
DELETE FROM user_permissions WHERE permission_key = 'accounting.access';
