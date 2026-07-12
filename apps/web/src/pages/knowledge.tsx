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
import { EmptyState } from "../UiStates";

type LocalDocument = {
  id: string;
  filename: string;
  status: "staged" | "ready";
};

export function KnowledgePage() {
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [query, setQuery] = useState("margen mínimo");
  const [lastSearch, setLastSearch] = useState("margen mínimo");

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
          <p className="eyebrow">Conocimiento local</p>
          <h2 id="knowledge-heading">Base de conocimiento</h2>
        </div>
        <div className="compact-stats">
          <span>{documents.length} archivos preparados</span>
          <span>API de ingesta pendiente</span>
          <span>Llave del cliente</span>
        </div>
      </div>

      <article className="panel knowledge-boundary">
        <CloudOff size={20} aria-hidden />
        <div>
          <strong>Conocimiento dentro del appliance</strong>
          <p>
            Esta vista prepara nombres de archivo. Cuando se conecte la API local, los documentos,
            fragmentos y embeddings permanecerán dentro del appliance del cliente.
          </p>
        </div>
      </article>

      <div className="knowledge-layout">
        <article className="panel knowledge-upload">
          <div className="panel-title">
            <Upload size={18} aria-hidden />
            <h3>Preparar archivos de criterios</h3>
          </div>
          <label>
            Archivos de criterios
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
              <EmptyState title="Sin archivos seleccionados" body="Selecciona criterios operativos para preparar su ingesta local." />
            )}
          </div>
          <button
            className="button button-primary"
            disabled={selectedFiles.length === 0}
            onClick={stageSelectedFiles}
            type="button"
          >
            <Database size={16} aria-hidden />
            Preparar vista local
          </button>
        </article>

        <article className="panel knowledge-search">
          <div className="panel-title">
            <Search size={18} aria-hidden />
            <h3>Buscar criterios</h3>
          </div>
          <form className="search-row" onSubmit={searchKnowledge}>
            <label>
              Consulta local
              <input onChange={(event) => setQuery(event.target.value)} type="search" value={query} />
            </label>
            <button className="button button-secondary" type="submit">
              <Search size={16} aria-hidden />
              Buscar
            </button>
          </form>
          <div className="knowledge-results" aria-label="Resultados de búsqueda local">
            {searchResults.length > 0 ? (
              searchResults.map((document) => (
                <section className="knowledge-result" key={document.id}>
                  <BookOpen size={16} aria-hidden />
                  <div>
                    <strong>{document.filename}</strong>
                    <small>{document.status === "staged" ? "Preparado" : "Listo"}; ingesta pendiente</small>
                  </div>
                </section>
              ))
            ) : (
              <EmptyState title="Sin coincidencias" body="Prueba otro término o prepara archivos adicionales." />
            )}
          </div>
        </article>

        <aside className="panel knowledge-contract">
          <div className="panel-title">
            <KeyRound size={18} aria-hidden />
            <h3>Contrato de ejecución</h3>
          </div>
          <ul className="boundary-list boundary-list-light">
            <li>La llave de embeddings se referencia como secreto local.</li>
            <li>El RAG solo puede orientar criterios de aprobación.</li>
            <li>La nube recibe conteos y salud, nunca documentos ni embeddings.</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}

export default KnowledgePage;
