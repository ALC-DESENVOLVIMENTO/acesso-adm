import { CaretLeft, CaretRight } from "@phosphor-icons/react";

type Props = {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  itemLabel?: string;
};

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  itemLabel = "registros"
}: Props) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);

  if (totalItems <= pageSize) {
    return null;
  }

  const firstItem = (safePage - 1) * pageSize + 1;
  const lastItem = Math.min(safePage * pageSize, totalItems);

  return (
    <nav className="pagination" aria-label={`Paginação de ${itemLabel}`}>
      <span className="pagination__summary" aria-live="polite">
        {firstItem}–{lastItem} de {totalItems} {itemLabel}
      </span>
      <div className="pagination__controls">
        <button
          className="ghost-button ghost-button--small"
          type="button"
          disabled={safePage === 1}
          onClick={() => onPageChange(safePage - 1)}
          aria-label="Página anterior"
        >
          <CaretLeft size={16} />
          Anterior
        </button>
        <span className="pagination__page">Página {safePage} de {totalPages}</span>
        <button
          className="ghost-button ghost-button--small"
          type="button"
          disabled={safePage === totalPages}
          onClick={() => onPageChange(safePage + 1)}
          aria-label="Próxima página"
        >
          Próxima
          <CaretRight size={16} />
        </button>
      </div>
    </nav>
  );
}

export function clampPage(page: number, totalItems: number, pageSize: number) {
  return Math.min(Math.max(page, 1), Math.max(1, Math.ceil(totalItems / pageSize)));
}

export function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const safePage = clampPage(page, items.length, pageSize);
  return items.slice((safePage - 1) * pageSize, safePage * pageSize);
}
