ALTER TABLE accounting_documents
  ADD COLUMN category TEXT NOT NULL DEFAULT 'acts'
  CHECK (category IN ('acts', 'drawings'));

CREATE INDEX accounting_documents_category_created
  ON accounting_documents(category, created_at);
