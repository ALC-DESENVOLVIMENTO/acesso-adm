import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { buildStorageObjectUrl } from "../../lib/storage.js";

const router = Router();

const PDFONLINE_BRIDGE_TOKEN = String(
  process.env.PDFONLINE_BRIDGE_TOKEN ||
    process.env.PDFONLINE_WEBHOOK_TOKEN ||
    process.env.PDFONLINE_INTEGRATION_TOKEN ||
    ""
).trim();

function normalizeIdentifier(value: string | null | undefined) {
  return String(value || "").trim();
}

function normalizeDigits(value: string | null | undefined) {
  return normalizeIdentifier(value).replace(/\D+/g, "");
}

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function readIntegrationToken(req: Request) {
  const authorization = String(req.headers.authorization || "").trim();

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return String(req.headers["x-bridge-token"] || req.headers["x-pdfonline-bridge-token"] || req.headers["x-portal-pdfonline-token"] || "").trim();
}

function isBridgeAuthorized(req: Request) {
  if (!PDFONLINE_BRIDGE_TOKEN) {
    return true;
  }

  return readIntegrationToken(req) === PDFONLINE_BRIDGE_TOKEN;
}

function selectPortalMotoristaFields() {
  return {
    id: true,
    nome: true,
    cpf: true,
    rg: true,
    dataNascimento: true,
    telefone: true,
    whatsapp: true,
    email: true,
    endereco: true,
    cidade: true,
    estado: true,
    cep: true,
    statusCadastro: true,
    empresaVinculada: true,
    observacoesGerais: true,
    criadoEm: true,
    atualizadoEm: true,
    classificacoes: {
      select: {
        criadoEm: true,
        classificacao: {
          select: {
            id: true,
            nome: true,
            descricao: true,
            ativa: true
          }
        }
      },
      orderBy: {
        criadoEm: "desc" as const
      }
    }
  };
}

function selectPortalUsuarioFields() {
  return {
    id: true,
    nome: true,
    email: true,
    fotoPerfil: true,
    ativo: true,
    bloqueado: true,
    primeiroAcesso: true,
    ultimoLoginEm: true,
    criadoEm: true,
    atualizadoEm: true,
    nivel: {
      select: {
        codigo: true,
        nome: true
      }
    }
  };
}

function selectUploadFields() {
  return {
    id: true,
    nomeArquivo: true,
    nomeOriginal: true,
    caminhoArquivo: true,
    status: true,
    versao: true,
    criadoEm: true,
    usuario: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    },
    periodoPagamento: {
      select: {
        id: true,
        nome: true,
        dataInicio: true,
        dataFim: true,
        tipo: true,
        status: true
      }
    },
    basePagamento: {
      select: {
        id: true,
        nome: true,
        tipoPadrao: true
      }
    },
    substituiUploadId: true
  };
}

function selectDriverPdfReceivedFields() {
  return {
    id: true,
    nomeArquivo: true,
    caminhoArquivo: true,
    tipoArquivo: true,
    uploadEm: true,
    status: true,
    observacoes: true,
    visualizadoEm: true,
    enviadoAoMotoristaEm: true,
    aprovadoEm: true,
    rejeitadoEm: true,
    motivoRejeicao: true,
    motoristaId: true,
    periodoPagamentoId: true,
    basePagamentoId: true,
    usuario: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    },
    aprovador: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    },
    rejeitador: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    },
    periodoPagamento: {
      select: {
        id: true,
        nome: true,
        dataInicio: true,
        dataFim: true,
        tipo: true,
        status: true
      }
    },
    basePagamento: {
      select: {
        id: true,
        nome: true,
        tipoPadrao: true
      }
    }
  };
}

function selectChamadoFields() {
  return {
    id: true,
    titulo: true,
    assunto: true,
    categoria: true,
    prioridade: true,
    descricao: true,
    status: true,
    abertoEm: true,
    atualizadoEm: true,
    encerradoEm: true,
    motivoConclusao: true,
    solucaoAplicada: true,
    observacoesFinais: true,
    tempoTotalMinutos: true,
    solicitante: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    },
    responsavel: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    },
    historicos: {
      select: {
        id: true,
        descricao: true,
        criadoEm: true,
        usuario: {
          select: {
            id: true,
            nome: true,
            email: true
          }
        },
        anexos: {
          select: {
            id: true,
            nomeArquivo: true,
            nomeOriginal: true,
            caminhoArquivo: true,
            criadoEm: true
          }
        }
      },
      orderBy: {
        criadoEm: "asc" as const
      }
    },
    anexos: {
      select: {
        id: true,
        nomeArquivo: true,
        nomeOriginal: true,
        caminhoArquivo: true,
        criadoEm: true
      }
    }
  };
}

function selectAtendimentoFields() {
  return {
    id: true,
    canal: true,
    resumo: true,
    observacoes: true,
    tempoMinutos: true,
    dataHora: true,
    atendente: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    }
  };
}

function selectNotaFields() {
  return {
    id: true,
    conteudo: true,
    criadoEm: true,
    atualizadoEm: true,
    usuario: {
      select: {
        id: true,
        nome: true,
        email: true
      }
    }
  };
}

function serializeMotorista(motorista: any) {
  if (!motorista) {
    return null;
  }

  return {
    id: motorista.id,
    nome: motorista.nome,
    cpf: motorista.cpf,
    rg: motorista.rg,
    dataNascimento: normalizeDate(motorista.dataNascimento),
    telefone: motorista.telefone,
    whatsapp: motorista.whatsapp,
    email: motorista.email,
    endereco: motorista.endereco,
    cidade: motorista.cidade,
    estado: motorista.estado,
    cep: motorista.cep,
    statusCadastro: motorista.statusCadastro,
    empresaVinculada: motorista.empresaVinculada,
    observacoesGerais: motorista.observacoesGerais,
    criadoEm: normalizeDate(motorista.criadoEm),
    atualizadoEm: normalizeDate(motorista.atualizadoEm),
      classificacoes: motorista.classificacoes.map((item: any) => ({
      id: item.classificacao.id,
      nome: item.classificacao.nome,
      descricao: item.classificacao.descricao,
      ativa: item.classificacao.ativa,
      criadoEm: normalizeDate(item.criadoEm)
    }))
  };
}

function serializeUsuario(usuario: any) {
  if (!usuario) {
    return null;
  }

  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    fotoPerfil: buildStorageObjectUrl(usuario.fotoPerfil),
    ativo: usuario.ativo,
    bloqueado: usuario.bloqueado,
    primeiroAcesso: usuario.primeiroAcesso,
    ultimoLoginEm: normalizeDate(usuario.ultimoLoginEm),
    criadoEm: normalizeDate(usuario.criadoEm),
    atualizadoEm: normalizeDate(usuario.atualizadoEm),
    nivel: {
      codigo: usuario.nivel.codigo,
      nome: usuario.nivel.nome
    }
  };
}

function serializeUpload(upload: any) {
  return {
    id: upload.id,
    fileName: upload.nomeOriginal,
    storageFileName: upload.nomeArquivo,
    storagePath: upload.caminhoArquivo,
    status: upload.status,
    version: upload.versao,
    createdAt: normalizeDate(upload.criadoEm),
    downloadUrl: buildStorageObjectUrl(upload.caminhoArquivo),
    owner: upload.usuario
      ? {
          id: upload.usuario.id,
          nome: upload.usuario.nome,
          email: upload.usuario.email
        }
      : null,
    period: upload.periodoPagamento
      ? {
          id: upload.periodoPagamento.id,
          nome: upload.periodoPagamento.nome,
          dataInicio: normalizeDate(upload.periodoPagamento.dataInicio),
          dataFim: normalizeDate(upload.periodoPagamento.dataFim),
          tipo: upload.periodoPagamento.tipo,
          status: upload.periodoPagamento.status
        }
      : null,
    base: upload.basePagamento
      ? {
          id: upload.basePagamento.id,
          nome: upload.basePagamento.nome,
          tipoPadrao: upload.basePagamento.tipoPadrao
        }
      : null,
    replacedUploadId: upload.substituiUploadId
  };
}

function serializeDriverPdfReceived(received: any) {
  return {
    id: received.id,
    fileName: received.nomeArquivo,
    storagePath: received.caminhoArquivo,
    fileType: received.tipoArquivo,
    uploadAt: normalizeDate(received.uploadEm),
    status: received.status,
    observations: received.observacoes,
    visualizedAt: normalizeDate(received.visualizadoEm),
    sentToDriverAt: normalizeDate(received.enviadoAoMotoristaEm),
    approvedAt: normalizeDate(received.aprovadoEm),
    rejectedAt: normalizeDate(received.rejeitadoEm),
    rejectionReason: received.motivoRejeicao,
    downloadUrl: buildStorageObjectUrl(received.caminhoArquivo),
    owner: received.usuario
      ? {
          id: received.usuario.id,
          nome: received.usuario.nome,
          email: received.usuario.email
        }
      : null,
    approver: received.aprovador
      ? {
          id: received.aprovador.id,
          nome: received.aprovador.nome,
          email: received.aprovador.email
        }
      : null,
    rejecter: received.rejeitador
      ? {
          id: received.rejeitador.id,
          nome: received.rejeitador.nome,
          email: received.rejeitador.email
        }
      : null,
    period: received.periodoPagamento
      ? {
          id: received.periodoPagamento.id,
          nome: received.periodoPagamento.nome,
          dataInicio: normalizeDate(received.periodoPagamento.dataInicio),
          dataFim: normalizeDate(received.periodoPagamento.dataFim),
          tipo: received.periodoPagamento.tipo,
          status: received.periodoPagamento.status
        }
      : null,
    base: received.basePagamento
      ? {
          id: received.basePagamento.id,
          nome: received.basePagamento.nome,
          tipoPadrao: received.basePagamento.tipoPadrao
        }
      : null
  };
}

function serializeAtendimento(atendimento: any) {
  return {
    id: atendimento.id,
    channel: atendimento.canal,
    summary: atendimento.resumo,
    observations: atendimento.observacoes,
    durationMinutes: atendimento.tempoMinutos,
    occurredAt: normalizeDate(atendimento.dataHora),
    attendant: {
      id: atendimento.atendente.id,
      nome: atendimento.atendente.nome,
      email: atendimento.atendente.email
    }
  };
}

function serializeNota(nota: any) {
  return {
    id: nota.id,
    content: nota.conteudo,
    createdAt: normalizeDate(nota.criadoEm),
    updatedAt: normalizeDate(nota.atualizadoEm),
    user: {
      id: nota.usuario.id,
      nome: nota.usuario.nome,
      email: nota.usuario.email
    }
  };
}

function serializeChamado(chamado: any) {
  return {
    id: chamado.id,
    title: chamado.titulo,
    subject: chamado.assunto,
    category: chamado.categoria,
    priority: chamado.prioridade,
    description: chamado.descricao,
    status: chamado.status,
    openedAt: normalizeDate(chamado.abertoEm),
    updatedAt: normalizeDate(chamado.atualizadoEm),
    closedAt: normalizeDate(chamado.encerradoEm),
    closingReason: chamado.motivoConclusao,
    solutionApplied: chamado.solucaoAplicada,
    finalNotes: chamado.observacoesFinais,
    totalMinutes: chamado.tempoTotalMinutos,
    requester: {
      id: chamado.solicitante.id,
      nome: chamado.solicitante.nome,
      email: chamado.solicitante.email
    },
    responsible: chamado.responsavel
      ? {
          id: chamado.responsavel.id,
          nome: chamado.responsavel.nome,
          email: chamado.responsavel.email
        }
      : null,
    history: chamado.historicos.map((history: any) => ({
      id: history.id,
      description: history.descricao,
      createdAt: normalizeDate(history.criadoEm),
      user: {
        id: history.usuario.id,
        nome: history.usuario.nome,
        email: history.usuario.email
      },
      attachments: history.anexos.map((attachment: any) => ({
        id: attachment.id,
        fileName: attachment.nomeArquivo,
        originalName: attachment.nomeOriginal,
        storagePath: attachment.caminhoArquivo,
        createdAt: normalizeDate(attachment.criadoEm),
        downloadUrl: buildStorageObjectUrl(attachment.caminhoArquivo)
      }))
    })),
    attachments: chamado.anexos.map((attachment: any) => ({
      id: attachment.id,
      fileName: attachment.nomeArquivo,
      originalName: attachment.nomeOriginal,
      storagePath: attachment.caminhoArquivo,
      createdAt: normalizeDate(attachment.criadoEm),
      downloadUrl: buildStorageObjectUrl(attachment.caminhoArquivo)
    }))
  };
}

async function resolvePortalBridge(identifier: string) {
  const rawIdentifier = normalizeIdentifier(identifier);

  if (!rawIdentifier) {
    return null;
  }

  const cpfDigits = normalizeDigits(rawIdentifier);
  const lowerIdentifier = rawIdentifier.toLowerCase();
  const motoristaWhere: any = {
    OR: [
      cpfDigits ? { cpf: cpfDigits } : null,
      { nome: { contains: rawIdentifier, mode: "insensitive" } },
      { email: { equals: lowerIdentifier, mode: "insensitive" } }
    ].filter(Boolean)
  };

  const motorista = await prisma.motorista.findFirst({
    where: motoristaWhere,
    select: selectPortalMotoristaFields()
  });

  const usuarioWhere: any = {
    OR: [
      { email: { equals: lowerIdentifier, mode: "insensitive" } },
      { nome: { contains: rawIdentifier, mode: "insensitive" } }
    ]
  };

  const usuario = await prisma.usuario.findFirst({
    where: usuarioWhere,
    select: selectPortalUsuarioFields()
  });

  const relatedMotoristaId = motorista?.id || null;
  const uploads = relatedMotoristaId
    ? await prisma.uploadPdf.findMany({
        where: {
          motoristaId: relatedMotoristaId
        },
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          periodoPagamento: {
            select: {
              id: true,
              nome: true,
              dataInicio: true,
              dataFim: true,
              tipo: true,
              status: true
            }
          },
          basePagamento: {
            select: {
              id: true,
              nome: true,
              tipoPadrao: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      })
    : [];

  const pdfsRecebidos = relatedMotoristaId
    ? await prisma.driverPdfReceived.findMany({
        where: {
          motoristaId: relatedMotoristaId
        },
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          aprovador: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          rejeitador: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          periodoPagamento: {
            select: {
              id: true,
              nome: true,
              dataInicio: true,
              dataFim: true,
              tipo: true,
              status: true
            }
          },
          basePagamento: {
            select: {
              id: true,
              nome: true,
              tipoPadrao: true
            }
          }
        },
        orderBy: {
          uploadEm: "desc"
        }
      })
    : [];

  const chamados = relatedMotoristaId
    ? await prisma.chamado.findMany({
        where: {
          motoristaId: relatedMotoristaId
        },
        include: {
          solicitante: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          responsavel: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          historicos: {
            include: {
              usuario: {
                select: {
                  id: true,
                  nome: true,
                  email: true
                }
              },
              anexos: true
            },
            orderBy: {
              criadoEm: "asc"
            }
          },
          anexos: true
        },
        orderBy: {
          atualizadoEm: "desc"
        }
      })
    : [];

  const atendimentos = relatedMotoristaId
    ? await prisma.atendimento.findMany({
        where: {
          motoristaId: relatedMotoristaId
        },
        include: {
          atendente: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          }
        },
        orderBy: {
          dataHora: "desc"
        }
      })
    : [];

  const notas = relatedMotoristaId
    ? await prisma.notaAtendimento.findMany({
        where: {
          motoristaId: relatedMotoristaId
        },
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          }
        },
        orderBy: {
          atualizadoEm: "desc"
        }
      })
    : [];

  const periodIds = Array.from(
    new Set(
      [
        ...uploads.map((item) => item.periodoPagamentoId).filter((value): value is string => Boolean(value)),
        ...pdfsRecebidos.map((item) => item.periodoPagamentoId).filter((value): value is string => Boolean(value))
      ]
    )
  );

  const periodos = periodIds.length
    ? await prisma.periodoPagamento.findMany({
        where: {
          id: {
            in: periodIds
          }
        },
        include: {
          criadoPor: {
            select: {
              id: true,
              nome: true,
              email: true
            }
          },
          bases: {
            include: {
              basePagamento: {
                select: {
                  id: true,
                  nome: true,
                  tipoPadrao: true
                }
              }
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      })
    : [];

  return {
    contractVersion: "1.0.0",
    sourceSystem: "portal-administrativo",
    targetSystem: "pdfonline",
    lookup: {
      requestedBy: rawIdentifier,
      cpf: cpfDigits || null,
      matchedBy: motorista?.cpf === cpfDigits ? "cpf" : usuario?.email === lowerIdentifier ? "email" : motorista ? "nome" : usuario ? "usuario" : null
    },
    identity: {
      motorista: serializeMotorista(motorista),
      usuario: serializeUsuario(usuario)
    },
    uploadsPdf: uploads.map(serializeUpload),
    driverPdfReceived: pdfsRecebidos.map(serializeDriverPdfReceived),
    atendimentos: atendimentos.map(serializeAtendimento),
    chamados: chamados.map(serializeChamado),
    notas: notas.map(serializeNota),
    periodos: periodos.map((periodo) => ({
      id: periodo.id,
      nome: periodo.nome,
      dataInicio: normalizeDate(periodo.dataInicio),
      dataFim: normalizeDate(periodo.dataFim),
      tipo: periodo.tipo,
      status: periodo.status,
      criadoEm: normalizeDate(periodo.criadoEm),
      atualizadoEm: normalizeDate(periodo.atualizadoEm),
      criadoPor: {
        id: periodo.criadoPor.id,
        nome: periodo.criadoPor.nome,
        email: periodo.criadoPor.email
      },
      bases: periodo.bases.map((item) => ({
        id: item.basePagamento.id,
        nome: item.basePagamento.nome,
        tipoPadrao: item.basePagamento.tipoPadrao
      }))
    })),
    summary: {
      motoristaFound: Boolean(motorista),
      usuarioFound: Boolean(usuario),
      uploadsCount: uploads.length,
      driverPdfReceivedCount: pdfsRecebidos.length,
      chamadosCount: chamados.length,
      atendimentosCount: atendimentos.length,
      notasCount: notas.length,
      periodosCount: periodos.length
    }
  };
}

function buildCompatibilityMap() {
  return {
    contractVersion: "1.0.0",
    sourceSystem: "portal-administrativo",
    targetSystem: "pdfonline",
    routes: [
      {
        method: "GET",
        path: "/api/integrations/pdfonline/bridge",
        purpose: "portal -> pdfonline: carrega motorista, PDFs, periodos, chamados e atendimentos"
      },
      {
        method: "POST",
        path: "/api/integrations/pdfonline/sync",
        purpose: "pdfonline -> portal: envia retorno consolidado e atualizacoes de processamento"
      },
      {
        method: "GET",
        path: "/api/integrations/pdfonline/compatibility-map",
        purpose: "documenta o contrato oficial entre os dois sistemas"
      }
    ],
    auth: {
      headerPriority: ["authorization: Bearer", "x-bridge-token", "x-pdfonline-bridge-token", "x-portal-pdfonline-token"],
      envTokenNames: ["PDFONLINE_BRIDGE_TOKEN", "PDFONLINE_WEBHOOK_TOKEN", "PDFONLINE_INTEGRATION_TOKEN"]
    },
    payloads: {
      bridge: {
        required: ["identifier or cpf"],
        optional: ["event", "scope", "source", "metadata"]
      },
      sync: {
        required: ["identifier or cpf"],
        optional: ["event", "scope", "source", "metadata", "bridge"]
      }
    }
  };
}

router.get("/compatibility-map", (_req, res) => {
  res.json(buildCompatibilityMap());
});

router.get("/bridge", (req, res) => {
  void (async () => {
    if (!isBridgeAuthorized(req)) {
      res.status(401).json({
        message: "Token de integracao invalido."
      });
      return;
    }

    const identifier = String(req.query.identifier || req.query.cpf || "").trim();
    const bridge = await resolvePortalBridge(identifier);

    if (!bridge) {
      res.status(404).json({
        message: "Cadastro nao encontrado para o identificador informado."
      });
      return;
    }

    res.json(bridge);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao montar a ponte com o pdfonline.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/sync", (req, res) => {
  void (async () => {
    if (!isBridgeAuthorized(req)) {
      res.status(401).json({
        message: "Token de integracao invalido."
      });
      return;
    }

    const schema = z.object({
      identifier: z.string().optional(),
      cpf: z.string().optional(),
      event: z.string().optional(),
      scope: z.string().optional(),
      source: z.string().optional(),
      metadata: z.record(z.any()).optional(),
      bridge: z.record(z.any()).optional()
    });

    const parsed = schema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({
        message: "Payload de sincronizacao invalido.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const identifier = parsed.data.identifier || parsed.data.cpf || "";
    const bridge = await resolvePortalBridge(identifier);

    if (!bridge) {
      res.status(404).json({
        message: "Cadastro nao encontrado para sincronizacao."
      });
      return;
    }

    await prisma.logAuditoria.create({
      data: {
        acao: "sync_pdfonline",
        entidade: "integracao_pdfonline",
        entidadeId: bridge.identity.motorista?.id || null,
        detalhes: {
          event: parsed.data.event || "sync",
          scope: parsed.data.scope || null,
          source: parsed.data.source || "pdfonline",
          metadata: parsed.data.metadata || null
        }
      }
    });

    res.json({
      ok: true,
      receivedAt: new Date().toISOString(),
      bridge
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao sincronizar com o pdfonline.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
