import { Database, FileArrowUp, PencilSimple, ToggleLeft, ToggleRight } from "@phosphor-icons/react";
import { ChangeEvent, useState } from "react";
import { importPaymentBases, type PaymentBase } from "./lib/api";

type Props = {
  token: string;
  bases: PaymentBase[];
  onRefresh: () => Promise<void>;
  onOpenEditor: (base: PaymentBase | null) => void;
  onToggleActive: (base: PaymentBase) => Promise<boolean> | boolean;
};

export function BasesScreen({ token, bases, onRefresh, onOpenEditor, onToggleActive }: Props) {
  const [search, setSearch] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const filtered = bases.filter((base) => `${base.name} ${base.acronym || ""}`.toLowerCase().includes(search.toLowerCase()));
  const handleImport = async () => {
    if (!file) return;
    setLoading(true); setMessage(""); setError("");
    try { const result = await importPaymentBases(token, file); setMessage(result.message); setFile(null); await onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao importar bases."); }
    finally { setLoading(false); }
  };
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] || null);
  return <main className="content-page bases-screen"><header className="page-heading"><div><p className="eyebrow">CADASTROS</p><h1>Cadastros de Bases</h1><p>Fonte oficial de nomes e siglas utilizada no portal, nos períodos, PDFs, financeiro e faturamento.</p></div><button className="primary-button cta-motion" type="button" onClick={() => onOpenEditor(null)}><Database size={18} /> Nova base</button></header>
    <section className="bases-toolbar"><label className="bases-search"><span>Pesquisar base</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome ou sigla" /></label><label className="bases-import"><FileArrowUp size={18} /><span>{file ? file.name : "Atualizar Bases e Siglas.xlsx"}<input type="file" accept=".xlsx,.xls" onChange={handleFile} /></span></label><button className="secondary-button" type="button" disabled={!file || loading} onClick={() => void handleImport()}>Atualizar cadastro</button></section>
    {message ? <div className="inline-alert inline-alert--success">{message}</div> : null}{error ? <div className="inline-alert inline-alert--error">{error}</div> : null}
    <section className="panel bases-panel"><div className="panel-heading"><div><p className="eyebrow">BASES OFICIAIS</p><h2>{filtered.length} bases cadastradas</h2></div><span className="bases-source">Nome e sigla refletem no sistema inteiro</span></div><div className="bases-table-wrap"><table><thead><tr><th>Nome da base</th><th>Sigla</th><th>Tipo padrão</th><th>Status</th><th>Ações</th></tr></thead><tbody>{filtered.map((base) => <tr key={base.id}><td><strong>{base.name}</strong></td><td><span className="base-acronym">{base.acronym || "Não cadastrada"}</span></td><td>{base.paymentType}</td><td><span className={`status-pill ${base.active ? "status-pill--active" : "status-pill--inactive"}`}>{base.active ? "Ativa" : "Inativa"}</span></td><td><div className="bases-actions"><button className="ghost-button ghost-button--small" type="button" onClick={() => onOpenEditor(base)}><PencilSimple size={16} /> Editar</button><button className="ghost-button ghost-button--small" type="button" onClick={() => void onToggleActive(base)}>{base.active ? <ToggleLeft size={16} /> : <ToggleRight size={16} />} {base.active ? "Desativar" : "Ativar"}</button></div></td></tr>)}</tbody></table></div></section>
  </main>;
}
