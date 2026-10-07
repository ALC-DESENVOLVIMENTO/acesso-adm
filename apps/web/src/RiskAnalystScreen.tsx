import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { fetchPaymentPeriods, fetchRiskPeriodReview, type PaymentPeriod, type RiskPeriodDiscrepancy } from "./lib/api";

type RiskAnalystScreenProps = { token: string };

function formatDate(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR").format(date);
}

function periodLabel(period: PaymentPeriod) {
  return `${period.name} · ${formatDate(period.startDate)} a ${formatDate(period.endDate)}`;
}

function formatDocument(value: string, kind: "cpf" | "cnpj") {
  const digits = value.replace(/\D/g, "");
  if (kind === "cpf" && digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (kind === "cnpj" && digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return value;
}

export function RiskAnalystScreen({ token }: RiskAnalystScreenProps) {
  const [periods, setPeriods] = useState<PaymentPeriod[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [items, setItems] = useState<RiskPeriodDiscrepancy[]>([]);
  const [loadingPeriods, setLoadingPeriods] = useState(true);
  const [loadingReview, setLoadingReview] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshPeriods = useCallback(async () => {
    setLoadingPeriods(true);
    setError("");
    try {
      const result = await fetchPaymentPeriods(token);
      setPeriods(result);
      setSelectedPeriodId((current) => result.some((period) => period.id === current) ? current : result[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os períodos.");
    } finally {
      setLoadingPeriods(false);
    }
  }, [token]);

  useEffect(() => { void refreshPeriods(); }, [refreshPeriods]);

  useEffect(() => {
    if (!token || !selectedPeriodId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoadingReview(true);
    setError("");
    void fetchRiskPeriodReview(token, selectedPeriodId)
      .then((result) => { if (!cancelled) setItems(result.items); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Não foi possível consultar as divergências."); })
      .finally(() => { if (!cancelled) setLoadingReview(false); });
    return () => { cancelled = true; };
  }, [refreshKey, selectedPeriodId, token]);

  const loading = loadingPeriods || loadingReview;

  return (
    <section className="risk-review screen">
      <header className="risk-review__header">
        <div>
          <p className="eyebrow">Gerenciadora de Risco</p>
          <h1>Revisão de cadastros</h1>
        </div>
        <button className="ghost-button" type="button" onClick={() => { setRefreshKey((value) => value + 1); void refreshPeriods(); }} disabled={loading} title="Atualizar">
          <ArrowClockwise size={17} /> Atualizar
        </button>
      </header>

      <label className="risk-review__period-picker">
        <span>Período disponível</span>
        <select value={selectedPeriodId} onChange={(event) => setSelectedPeriodId(event.target.value)} disabled={loadingPeriods || periods.length === 0}>
          {periods.length === 0 ? <option value="">Nenhum período disponível</option> : null}
          {periods.map((period) => <option key={period.id} value={period.id}>{periodLabel(period)}</option>)}
        </select>
      </label>

      <div className="risk-review__results-heading">
        <strong>Divergências do período</strong>
        {!loading ? <span>{items.length} {items.length === 1 ? "cadastro" : "cadastros"}</span> : null}
      </div>

      {error ? <div className="risk-review__message" role="alert"><WarningCircle size={18} />{error}</div> : null}
      {loading ? <div className="risk-review__empty" role="status">Carregando...</div> : null}
      {!loading && !error && !items.length ? <div className="risk-review__empty">Nenhuma divergência encontrada neste período.</div> : null}
      {!loading && !error && items.length ? (
        <div className="table-wrap">
          <table className="data-table risk-review__table">
            <thead><tr><th>Motorista</th><th>CPF</th><th>CNPJ do documento</th><th>CNPJ no ARCHI</th><th>Base do período</th><th>Divergência</th><th>Data</th></tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.motoristaNome}</strong></td>
                <td>{formatDocument(item.motoristaCpf, "cpf")}</td>
                <td>{formatDocument(item.cnpjDocumento, "cnpj")}</td>
                <td>{formatDocument(item.cnpjArchi, "cnpj")}</td>
                <td>{item.baseEnviada}</td>
                <td><div className="risk-review__categories">{item.categories.map((category) => <span key={category}>{category}</span>)}</div></td>
                <td>{formatDate(item.uploadedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
