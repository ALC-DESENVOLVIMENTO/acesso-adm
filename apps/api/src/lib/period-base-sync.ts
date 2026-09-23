import { PeriodStatus } from "@prisma/client";
import { prisma } from "./prisma.js";

const openPeriodStatuses = [PeriodStatus.disponivel, PeriodStatus.aguardando_aprovacao];

function isCompatiblePeriod(periodType: string, baseType: string) {
  return periodType === "mensal" || periodType === baseType;
}

export async function syncBaseToOpenPaymentPeriods(baseId: string) {
  const [base, periods] = await Promise.all([
    prisma.basePagamento.findUnique({
      where: { id: baseId },
      select: { id: true, tipoPadrao: true, ativo: true }
    }),
    prisma.periodoPagamento.findMany({
      where: {
        ativo: true,
        status: { in: openPeriodStatuses }
      },
      select: { id: true, tipo: true }
    })
  ]);

  if (!base?.ativo) {
    return 0;
  }

  const compatiblePeriods = periods.filter((period) =>
    isCompatiblePeriod(period.tipo, base.tipoPadrao)
  );

  if (compatiblePeriods.length === 0) {
    return 0;
  }

  const result = await prisma.periodoPagamentoBase.createMany({
    data: compatiblePeriods.map((period) => ({
      periodoId: period.id,
      basePagamentoId: base.id
    })),
    skipDuplicates: true
  });

  return result.count;
}

export async function syncAllOpenPaymentPeriodBases() {
  const [bases, periods] = await Promise.all([
    prisma.basePagamento.findMany({
      where: { ativo: true },
      select: { id: true, tipoPadrao: true }
    }),
    prisma.periodoPagamento.findMany({
      where: {
        ativo: true,
        status: { in: openPeriodStatuses }
      },
      select: { id: true, tipo: true }
    })
  ]);

  const links = periods.flatMap((period) =>
    bases
      .filter((base) => isCompatiblePeriod(period.tipo, base.tipoPadrao))
      .map((base) => ({
        periodoId: period.id,
        basePagamentoId: base.id
      }))
  );

  if (links.length === 0) {
    return 0;
  }

  const result = await prisma.periodoPagamentoBase.createMany({
    data: links,
    skipDuplicates: true
  });

  return result.count;
}
