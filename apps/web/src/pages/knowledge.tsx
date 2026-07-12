import { useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  BookOpen,
  CloudOff,
  Database,
  FileText,
  KeyRound,
  Search,
  Upload
} from "lucide-react";

type LocalDocument = {
  id: string;
  filename: string;
  status: "staged" | "ready";
};

export function KnowledgePage() {
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [query, setQuery] = useState("margin floor");
  const [lastSearch, setLastSearch] = useState("margin floor");

  const searchResults = useMemo(() => {
    const normalizedQuery = lastSearch.trim().toLowerCase();
    if (!normalizedQuery) return [];

    return documents
      .filter((document) => document.filename.toLowerCase().includes(normalizedQuery))
      .slice(0, 4);
  }, [documents, lastSearch]);

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(Array.from(event.target.files ?? []));
  }

  function stageSelectedFiles() {
    if (selectedFiles.length === 0) return;
    setDocuments((current) => [
      ...selectedFiles.map((file, index) => ({
        id: `local-${Date.now()}-${index}`,
        filename: file.name,
        status: "staged" as const
      })),
      ...current
    ]);
    setSelectedFiles([]);
  }

  function searchKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLastSearch(query);
  }

  return (
    <section aria-labelledby="knowledge-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Local RAG</p>
          <h2 id="knowledge-heading">Knowledge staging preview</h2>
        </div>
        <div className="compact-stats">
          <span>{documents.length} staged files</span>
          <span>ingest API not mounted</span>
          <span>client-owned embedding key</span>
        </div>
      </div>

      <article className="panel knowledge-boundary">
        <CloudOff size={20} aria-hidden />
        <div>
          <strong>Local appliance knowledge base</strong>
          <p>
            This screen stages local filenames only. Once the local knowledge API is mounted,
            documents, chunks, and embeddings stay inside the client appliance.
          </p>
        </div>
      </article>

      <div className="knowledge-layout">
        <article className="panel knowledge-upload">
          <div className="panel-title">
            <Upload size={18} aria-hidden />
            <h3>Stage criteria files</h3>
          </div>
          <label>
            Criteria files
            <input multiple onChange={selectFiles} type="file" />
          </label>
          <div className="selected-file-list" aria-label="Selected local files">
            {selectedFiles.length > 0 ? (
              selectedFiles.map((file) => (
                <span key={`${file.name}-${file.size}`}>
                  <FileText size={15} aria-hidden />
                  {file.name}
                </span>
              ))
            ) : (
              <p className="muted">
                No files selected. This preview stages filenames only until local knowledge API
                routes are mounted.
              </p>
            )}
          </div>
          <button
            className="button button-primary"
            disabled={selectedFiles.length === 0}
            onClick={stageSelectedFiles}
            type="button"
          >
            <Database size={16} aria-hidden />
            Stage local preview
          </button>
        </article>

        <article className="panel knowledge-search">
          <div className="panel-title">
            <Search size={18} aria-hidden />
            <h3>Search criteria</h3>
          </div>
          <form className="search-row" onSubmit={searchKnowledge}>
            <label>
              Local query
              <input onChange={(event) => setQuery(event.target.value)} type="search" value={query} />
            </label>
            <button className="button button-secondary" type="submit">
              <Search size={16} aria-hidden />
              Search
            </button>
          </form>
          <div className="knowledge-results" aria-label="Local RAG search results">
            {searchResults.length > 0 ? (
              searchResults.map((document) => (
                <section className="knowledge-result" key={document.id}>
                  <BookOpen size={16} aria-hidden />
                  <div>
                    <strong>{document.filename}</strong>
                    <small>{document.status} for local preview; not ingested yet</small>
                  </div>
                </section>
              ))
            ) : (
              <p className="muted">No staged local filenames matched this query.</p>
            )}
          </div>
        </article>

        <aside className="panel knowledge-contract">
          <div className="panel-title">
            <KeyRound size={18} aria-hidden />
            <h3>Runtime contract</h3>
          </div>
          <ul className="boundary-list boundary-list-light">
            <li>Embedding API key is a local secret reference.</li>
            <li>RAG output can advise approval criteria only.</li>
            <li>The cloud receives counts and health, not documents or embeddings.</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}

export default KnowledgePage;
