import { ArrowClockwise, CalendarBlank, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { fetchPaymentPeriods, fetchPeriodBaseReviews, type PaymentPeriod, type PeriodBaseReviewItem } from "./lib/api";

type RiskAnalystScreenProps = { token: string };
type Tab = "divergencias" | "periodos";

function formatDate(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR").format(date);
}

function periodStatus(status: PaymentPeriod["status"]) {
  return status.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function RiskAnalystScreen({ token }: RiskAnalystScreenProps) {
  const [tab, setTab] = useState<Tab>("divergencias");
  const [periods, setPeriods] = useState<PaymentPeriod[]>([]);
  const [reviews, setReviews] = useState<PeriodBaseReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [periodData, reviewData] = await Promise.all([
        fetchPaymentPeriods(token),
        fetchPeriodBaseReviews(token)
      ]);
      setPeriods(periodData);
      setReviews(reviewData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os dados.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="risk-review screen">
      <header className="risk-review__header">
        <div>
          <p className="eyebrow">Gerenciadora de Risco</p>
          <h1>Divergências cadastrais</h1>
          <p>Motoristas com divergência entre a base cadastrada e a base do período.</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void refresh()} disabled={loading} title="Atualizar">
          <ArrowClockwise size={17} /> Atualizar
        </button>
      </header>

      <div className="risk-review__tabs" role="tablist" aria-label="Dados para consulta">
        <button type="button" role="tab" aria-selected={tab === "divergencias"} onClick={() => setTab("divergencias")}>
          Divergências <span>{reviews.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "periodos"} onClick={() => setTab("periodos")}>
          Períodos <span>{periods.length}</span>
        </button>
      </div>

      {error ? <div className="risk-review__message" role="alert"><WarningCircle size={18} />{error}</div> : null}
      {loading ? <div className="risk-review__empty" role="status">Carregando dados...</div> : null}

      {!loading && !error && tab === "divergencias" ? (
        reviews.length ? (
          <div className="table-wrap">
            <table className="data-table risk-review__table">
              <thead><tr><th>Motorista</th><th>CPF</th><th>Base cadastrada</th><th>Base no período</th><th>Período</th><th>Enviado em</th></tr></thead>
              <tbody>{reviews.flatMap((review) => review.cases.map((item, index) => (
                <tr key={`${review.id}-${item.periodId}-${index}`}>
                  <td><strong>{review.motoristaNome}</strong></td>
                  <td>{review.motoristaCpf}</td>
                  <td>{review.baseRegistrada}</td>
                  <td>{item.baseEnviada}</td>
                  <td>{item.periodName}</td>
                  <td>{formatDate(item.uploadedAt)}</td>
                </tr>
              )))}</tbody>
            </table>
          </div>
        ) : <div className="risk-review__empty">Nenhuma divergência cadastral pendente.</div>
      ) : null}

      {!loading && !error && tab === "periodos" ? (
        periods.length ? (
          <div className="risk-review__period-list">
            {periods.map((period) => (
              <article className="risk-review__period" key={period.id}>
                <CalendarBlank size={20} />
                <div><strong>{period.name}</strong><span>{formatDate(period.startDate)} a {formatDate(period.endDate)} · {period.paymentType}</span></div>
                <span className="finance-status-pill finance-status-pill--neutral">{periodStatus(period.status)}</span>
              </article>
            ))}
          </div>
        ) : <div className="risk-review__empty">Nenhum período cadastrado.</div>
      ) : null}
    </section>
  );
}
