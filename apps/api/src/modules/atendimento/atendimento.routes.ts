import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireAdmin, requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();
const currentFile = fileURLToPath(import.meta.url);
const storageRoot = path.resolve(path.dirname(currentFile), "../../../storage/atendimento");

mkdirSync(storageRoot, { recursive: true });

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, storageRoot);
  },
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    callback(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage: attachmentStorage
});

router.use(requireAuth, requireModuleAccess("atendimento"));

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function routeParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }

  return String(value || "").trim();
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return {
    iso: date.toISOString(),
    date: date.toLocaleDateString("pt-BR"),
    time: date.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit"
    })
  };
}

function toAttachmentPayload(attachment: {
  id: string;
  nomeOriginal: string;
  caminhoArquivo: string;
  criadoEm: Date;
}) {
  return {
    id: attachment.id,
    fileName: attachment.nomeOriginal,
    storageFileName: attachment.caminhoArquivo.split("/").pop() || attachment.nomeOriginal,
    downloadUrl: `/storage/${attachment.caminhoArquivo.replace(/^storage\//, "")}`,
    createdAt: attachment.criadoEm
  };
}

function buildTimeline(
  motorista: {
    uploads: Array<{
      id: string;
      nomeOriginal: string;
      status: string;
      criadoEm: Date;
      usuario: { nome: string };
      periodoPagamento?: { nome: string } | null;
      basePagamento?: { nome: string } | null;
    }>;
    atendimentos: Array<{
      id: string;
      dataHora: Date;
      canal: string;
      resumo: string;
      observacoes: string | null;
      tempoMinutos: number | null;
      atendente: { nome: string };
    }>;
    chamados: Array<{
      id: string;
      abertoEm: Date;
      atualizadoEm: Date;
      encerradoEm: Date | null;
      titulo: string;
      assunto: string | null;
      status: string;
      prioridade: string;
      responsavel: { nome: string } | null;
      historicos: Array<{
        id: string;
        criadoEm: Date;
        descricao: string;
        usuario: { nome: string };
      }>;
    }>;
    notas: Array<{
      id: string;
      criadoEm: Date;
      conteudo: string;
      usuario: { nome: string };
    }>;
    logs: Array<{
      id: string;
      criadoEm: Date;
      acao: string;
      entidade: string;
      detalhes: unknown;
      usuario: { nome: string } | null;
    }>;
  }
) {
  const events = [
    ...motorista.uploads.map((upload) => ({
      id: `upload-${upload.id}`,
      type: "upload",
      title: `PDF anexado: ${upload.nomeOriginal}`,
      subtitle: `${upload.usuario.nome} · ${upload.periodoPagamento?.nome || "Sem periodo"}`,
      status: upload.status,
      at: upload.criadoEm
    })),
    ...motorista.atendimentos.map((item) => ({
      id: `atendimento-${item.id}`,
      type: "atendimento",
      title: `Atendimento via ${item.canal}`,
      subtitle: `${item.resumo} · ${item.atendente.nome}`,
      status: item.tempoMinutos ? `${item.tempoMinutos} min` : "Em andamento",
      at: item.dataHora
    })),
    ...motorista.chamados.flatMap((ticket) => [
      {
        id: `chamado-${ticket.id}`,
        type: "chamado",
        title: `Chamado aberto: ${ticket.assunto || ticket.titulo}`,
        subtitle: `${ticket.prioridade} · ${ticket.status}`,
        status: ticket.status,
        at: ticket.abertoEm
      },
      ...ticket.historicos.map((history) => ({
        id: `chamado-historico-${history.id}`,
        type: "chamado",
        title: `Movimentacao do chamado`,
        subtitle: `${history.usuario.nome} · ${history.descricao}`,
        status: ticket.status,
        at: history.criadoEm
      })),
      ...(ticket.encerradoEm
        ? [
            {
              id: `chamado-close-${ticket.id}`,
              type: "chamado",
              title: `Chamado encerrado: ${ticket.assunto || ticket.titulo}`,
              subtitle: ticket.responsavel?.nome || "Sem responsavel",
              status: ticket.status,
              at: ticket.encerradoEm
            }
          ]
        : [])
    ]),
    ...motorista.notas.map((note) => ({
      id: `nota-${note.id}`,
      type: "nota",
      title: "Nota interna registrada",
      subtitle: `${note.usuario.nome} · ${note.conteudo}`,
      status: "nota",
      at: note.criadoEm
    })),
    ...motorista.logs.map((log) => ({
      id: `log-${log.id}`,
      type: "log",
      title: `Log: ${log.acao}`,
      subtitle: `${log.usuario?.nome || "Sistema"} · ${log.entidade}`,
      status: "log",
      at: log.criadoEm
    }))
  ];

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).map((event) => ({
    ...event,
    ...formatDateTime(event.at)
  }));
}

async function loadMotoristaDetail(motoristaId: string) {
  const motorista = await prisma.motorista.findUnique({
    where: {
      id: motoristaId
    },
    include: {
      uploads: {
        include: {
          usuario: {
            select: {
              nome: true
            }
          },
          periodoPagamento: {
            select: {
              nome: true
            }
          },
          basePagamento: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      },
      atendimentos: {
        include: {
          atendente: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          dataHora: "desc"
        }
      },
      chamados: {
        include: {
          responsavel: {
            select: {
              nome: true
            }
          },
          historicos: {
            include: {
              usuario: {
                select: {
                  nome: true
                }
              }
            },
            orderBy: {
              criadoEm: "desc"
            }
          },
          anexos: true
        },
        orderBy: {
          atualizadoEm: "desc"
        }
      },
      notas: {
        include: {
          usuario: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      },
      classificacoes: {
        include: {
          classificacao: true
        },
        orderBy: {
          criadoEm: "desc"
        }
      },
      logs: {
        include: {
          usuario: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      }
    }
  });

  if (!motorista) {
    return null;
  }

  return {
    motorista: {
      id: motorista.id,
      nome: motorista.nome,
      cpf: motorista.cpf,
      rg: motorista.rg,
      dataNascimento: motorista.dataNascimento,
      telefone: motorista.telefone,
      whatsapp: motorista.whatsapp,
      email: motorista.email,
      endereco: motorista.endereco,
      cidade: motorista.cidade,
      estado: motorista.estado,
      cep: motorista.cep,
      statusCadastro: motorista.statusCadastro,
      dataCriacao: motorista.criadoEm,
      ultimaAtualizacao: motorista.atualizadoEm,
      empresaVinculada: motorista.empresaVinculada,
      observacoesGerais: motorista.observacoesGerais,
      classificacoes: motorista.classificacoes.map((item) => ({
        id: item.classificacao.id,
        name: item.classificacao.nome,
        description: item.classificacao.descricao,
        active: item.classificacao.ativa
      }))
    },
    pdfs: motorista.uploads.map((upload) => ({
      id: upload.id,
      nomeDocumento: upload.nomeOriginal,
      tipo: upload.basePagamento?.nome || "PDF",
      dataEnvio: upload.criadoEm,
      dataAprovacao: null,
      status: upload.status,
      usuarioResponsavel: upload.usuario.nome,
      periodName: upload.periodoPagamento?.nome || null,
      baseName: upload.basePagamento?.nome || null,
      downloadUrl: `/storage/${upload.caminhoArquivo.replace(/^storage\//, "")}`
    })),
    atendimentos: motorista.atendimentos.map((item) => ({
      id: item.id,
      dataHora: item.dataHora,
      atendente: item.atendente.nome,
      canal: item.canal,
      resumo: item.resumo,
      observacoes: item.observacoes,
      tempoAtendimento: item.tempoMinutos
    })),
    chamados: motorista.chamados.map((ticket) => ({
      id: ticket.id,
      numero: ticket.id.slice(0, 8).toUpperCase(),
      assunto: ticket.assunto || ticket.titulo,
      titulo: ticket.titulo,
      categoria: ticket.categoria || "Geral",
      prioridade: ticket.prioridade,
      status: ticket.status,
      responsavel: ticket.responsavel?.nome || null,
      dataAbertura: ticket.abertoEm,
      ultimaAtualizacao: ticket.atualizadoEm,
      encerradoEm: ticket.encerradoEm,
      motivoConclusao: ticket.motivoConclusao,
      solucaoAplicada: ticket.solucaoAplicada,
      observacoesFinais: ticket.observacoesFinais,
      historico: ticket.historicos.map((entry) => ({
        id: entry.id,
        dataHora: entry.criadoEm,
        usuario: entry.usuario.nome,
        descricao: entry.descricao
      })),
      anexos: ticket.anexos.map(toAttachmentPayload)
    })),
    notas: motorista.notas.map((note) => ({
      id: note.id,
      conteudo: note.conteudo,
      usuario: note.usuario.nome,
      dataHora: note.criadoEm
    })),
    timeline: buildTimeline(motorista),
    logs: motorista.logs.map((log) => ({
      id: log.id,
      acao: log.acao,
      entidade: log.entidade,
      entidadeId: log.entidadeId,
      detalhes: log.detalhes,
      usuario: log.usuario?.nome || "Sistema",
      dataHora: log.criadoEm
    }))
  };
}

router.get("/classificacoes", (_req, res) => {
  void (async () => {
    const classificacoes = await prisma.classificacaoMotorista.findMany({
      where: {
        ativa: true
      },
      orderBy: {
        nome: "asc"
      }
    });

    res.json(
      classificacoes.map((item) => ({
        id: item.id,
        name: item.nome,
        description: item.descricao,
        active: item.ativa
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar classificacoes.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/classificacoes", requireAdmin, (req, res) => {
  void (async () => {
    const body = req.body as Record<string, unknown>;
    const nome = String(body.name || "").trim();
    const descricao = String(body.description || "").trim() || null;

    if (!nome) {
      res.status(400).json({
        message: "Informe um nome para a classificacao."
      });
      return;
    }

    const classificacao = await prisma.classificacaoMotorista.upsert({
      where: {
        nome
      },
      update: {
        ativa: true,
        descricao: descricao || undefined
      },
      create: {
        nome,
        descricao
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth?.userId || null,
        acao: "criar_classificacao",
        entidade: "classificacoes_motorista",
        entidadeId: classificacao.id,
        detalhes: {
          nome,
          descricao
        }
      }
    });

    res.status(201).json({
      message: "Classificacao criada com sucesso.",
      classificacao: {
        id: classificacao.id,
        name: classificacao.nome,
        description: classificacao.descricao,
        active: classificacao.ativa
      }
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar classificacao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/motoristas/search", (_req, res) => {
  void (async () => {
    const query = normalizeText(String(_req.query.q || "").trim());
    const digits = digitsOnly(query);

    const motoristas = await prisma.motorista.findMany({
      where: query
        ? {
            OR: [
              {
                nome: {
                  contains: query,
                  mode: "insensitive"
                }
              },
              {
                cpf: {
                  contains: query
                }
              },
              ...(digits
                ? [
                    {
                      cpf: {
                        contains: digits
                      }
                    }
                  ]
                : [])
            ]
          }
        : undefined,
      orderBy: {
        nome: "asc"
      },
      take: 20,
      include: {
        classificacoes: {
          include: {
            classificacao: true
          }
        },
        uploads: {
          select: {
            id: true
          }
        },
        chamados: {
          select: {
            id: true
          }
        }
      }
    });

    res.json(
      motoristas.map((motorista) => ({
        id: motorista.id,
        name: motorista.nome,
        cpf: motorista.cpf,
        status: motorista.statusCadastro,
        city: motorista.cidade,
        state: motorista.estado,
        company: motorista.empresaVinculada,
        classifiedAs: motorista.classificacoes.map((item) => item.classificacao.nome),
        totalPdfs: motorista.uploads.length,
        totalChamados: motorista.chamados.length
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao localizar motorista.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/motoristas/:id", (req, res) => {
  void (async () => {
    const motoristaId = routeParam(req.params.id);
    const detail = await loadMotoristaDetail(motoristaId);

    if (!detail) {
      res.status(404).json({
        message: "Motorista nao encontrado."
      });
      return;
    }

    res.json(detail);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar motorista.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/motoristas/:id/classificacoes", (req, res) => {
  void (async () => {
    const motoristaId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const classificacaoIds = Array.isArray(body.classificacaoIds)
      ? body.classificacaoIds.map((value: unknown) => String(value))
      : [];

    await prisma.motoristaClassificacao.deleteMany({
      where: {
        motoristaId
      }
    });

    await prisma.motoristaClassificacao.createMany({
      data: classificacaoIds.map((classificacaoId: string) => ({
        motoristaId,
        classificacaoId
      }))
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth?.userId || null,
        motoristaId,
        acao: "alterar_classificacao_motorista",
        entidade: "motoristas",
        entidadeId: motoristaId,
        detalhes: {
          classificacaoIds
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.json({
      message: "Classificacoes atualizadas.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar classificacoes.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/motoristas/:id/notas", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const content = String(body.content || "").trim();

    if (!content) {
      res.status(400).json({
        message: "Informe o conteudo da nota."
      });
      return;
    }

    const note = await prisma.notaAtendimento.create({
      data: {
        motoristaId,
        usuarioId: req.auth.userId,
        conteudo: content
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "criar_nota_atendimento",
        entidade: "notas_atendimento",
        entidadeId: note.id,
        detalhes: {
          content
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.status(201).json({
      message: "Nota salva com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao salvar nota.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/motoristas/:id/notas/:notaId", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = routeParam(req.params.id);
    const notaId = routeParam(req.params.notaId);
    const body = req.body as Record<string, unknown>;
    const content = String(body.content || "").trim();

    if (!content) {
      res.status(400).json({
        message: "Informe o conteudo da nota."
      });
      return;
    }

    const note = await prisma.notaAtendimento.update({
      where: {
        id: notaId
      },
      data: {
        conteudo: content
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "editar_nota_atendimento",
        entidade: "notas_atendimento",
        entidadeId: note.id,
        detalhes: {
          content
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.json({
      message: "Nota atualizada com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar nota.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/motoristas/:id/notas/:notaId", requireAdmin, (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = routeParam(req.params.id);
    const notaId = routeParam(req.params.notaId);
    await prisma.notaAtendimento.delete({
      where: {
        id: notaId
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "excluir_nota_atendimento",
        entidade: "notas_atendimento",
        entidadeId: notaId
      }
    });

    res.json({
      message: "Nota removida com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao excluir nota.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/motoristas/:id/atendimentos", upload.array("attachments", 6), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const resumo = String(body.resumo || "").trim();
    const observacoes = String(body.observacoes || "").trim() || null;
    const canal = String(body.canal || "chat").trim();
    const tempoMinutos = Number(String(body.tempoMinutos || "").trim() || "0") || null;
    const files = (req.files as Express.Multer.File[]) || [];

    if (!resumo) {
      res.status(400).json({
        message: "Informe um resumo para o atendimento."
      });
      return;
    }

    const atendimento = await prisma.atendimento.create({
      data: {
        motoristaId,
        atendenteId: req.auth.userId,
        canal: canal as never,
        resumo,
        observacoes,
        tempoMinutos
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "criar_atendimento",
        entidade: "atendimentos",
        entidadeId: atendimento.id,
        detalhes: {
          resumo,
          canal,
          anexos: files.length
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.status(201).json({
      message: "Atendimento registrado com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao registrar atendimento.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/motoristas/:id/chamados", upload.array("attachments", 10), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const assunto = String(body.assunto || "").trim();
    const categoria = String(body.categoria || "").trim();
    const prioridade = String(body.prioridade || "media").trim();
    const descricao = String(body.descricao || "").trim();
    const responsavelId = String(body.responsavelId || req.auth.userId).trim() || req.auth.userId;
    const files = (req.files as Express.Multer.File[]) || [];

    if (!assunto || !categoria || !descricao) {
      res.status(400).json({
        message: "Preencha assunto, categoria e descricao."
      });
      return;
    }

    const sequence = String(Date.now()).slice(-6);
    const chamado = await prisma.chamado.create({
      data: {
        motoristaId,
        titulo: assunto,
        assunto,
        categoria,
        prioridade: prioridade as never,
        descricao,
        status: "aberto",
        solicitanteId: req.auth.userId,
        responsavelId,
        abertoEm: new Date()
      }
    });

    if (files.length > 0) {
      await prisma.anexoChamado.createMany({
        data: files.map((file) => ({
          chamadoId: chamado.id,
          nomeArquivo: file.filename,
          nomeOriginal: file.originalname,
          caminhoArquivo: path.relative(process.cwd(), file.path).replace(/\\/g, "/")
        }))
      });
    }

    await prisma.historicoChamado.create({
      data: {
        chamadoId: chamado.id,
        usuarioId: req.auth.userId,
        descricao: `Chamado ${sequence} criado.`
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        chamadoId: chamado.id,
        acao: "criar_chamado",
        entidade: "chamados",
        entidadeId: chamado.id,
        detalhes: {
          assunto,
          categoria,
          prioridade,
          responsavelId,
          anexos: files.length
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.status(201).json({
      message: "Chamado criado com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar chamado.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/chamados/:id/movimentos", upload.array("attachments", 10), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const chamadoId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const descricao = String(body.description || body.descricao || "").trim();
    const files = (req.files as Express.Multer.File[]) || [];

    if (!descricao) {
      res.status(400).json({
        message: "Informe a movimentacao do chamado."
      });
      return;
    }

    const chamado = await prisma.chamado.findUnique({
      where: {
        id: chamadoId
      }
    });

    if (!chamado) {
      res.status(404).json({
        message: "Chamado nao encontrado."
      });
      return;
    }

    const history = await prisma.historicoChamado.create({
      data: {
        chamadoId: chamado.id,
        usuarioId: req.auth.userId,
        descricao
      }
    });

    if (files.length > 0) {
      await prisma.anexoChamado.createMany({
        data: files.map((file) => ({
          chamadoId: chamado.id,
          historicoChamadoId: history.id,
          nomeArquivo: file.filename,
          nomeOriginal: file.originalname,
          caminhoArquivo: path.relative(process.cwd(), file.path).replace(/\\/g, "/")
        }))
      });
    }

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId: chamado.motoristaId,
        chamadoId: chamado.id,
        acao: "atualizar_chamado",
        entidade: "historico_chamados",
        entidadeId: history.id,
        detalhes: {
          descricao,
          anexos: files.length
        }
      }
    });

    res.status(201).json({
      message: "Movimentacao registrada."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao registrar movimentacao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/chamados/:id/encerrar", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const chamadoId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const motivoConclusao = String(body.motivoConclusao || "").trim();
    const solucaoAplicada = String(body.solucaoAplicada || "").trim();
    const observacoesFinais = String(body.observacoesFinais || "").trim();

    const chamado = await prisma.chamado.findUnique({
      where: {
        id: chamadoId
      }
    });

    if (!chamado) {
      res.status(404).json({
        message: "Chamado nao encontrado."
      });
      return;
    }

    const abertoEm = chamado.abertoEm || chamado.criadoEm;
    const tempoTotalMinutos = Math.max(
      1,
      Math.round((Date.now() - new Date(abertoEm).getTime()) / 60000)
    );

    await prisma.chamado.update({
      where: {
        id: chamado.id
      },
      data: {
        status: "concluido",
        encerradoEm: new Date(),
        motivoConclusao,
        solucaoAplicada,
        observacoesFinais,
        tempoTotalMinutos
      }
    });

    await prisma.historicoChamado.create({
      data: {
        chamadoId: chamado.id,
        usuarioId: req.auth.userId,
        descricao: `Chamado encerrado. Motivo: ${motivoConclusao || "Nao informado"}`
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId: chamado.motoristaId,
        chamadoId: chamado.id,
        acao: "encerrar_chamado",
        entidade: "chamados",
        entidadeId: chamado.id,
        detalhes: {
          motivoConclusao,
          solucaoAplicada,
          observacoesFinais,
          tempoTotalMinutos
        }
      }
    });

    res.json({
      message: "Chamado encerrado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao encerrar chamado.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/chamados/:id", (req, res) => {
  void (async () => {
    const chamadoId = routeParam(req.params.id);
    const chamado = await prisma.chamado.findUnique({
      where: {
        id: chamadoId
      },
      include: {
        responsavel: {
          select: {
            nome: true
          }
        },
        historicos: {
          include: {
            usuario: {
              select: {
                nome: true
              }
            }
          },
          orderBy: {
            criadoEm: "asc"
          }
        },
        anexos: true
      }
    });

    if (!chamado) {
      res.status(404).json({
        message: "Chamado nao encontrado."
      });
      return;
    }

    res.json({
      id: chamado.id,
      assunto: chamado.assunto || chamado.titulo,
      categoria: chamado.categoria || "Geral",
      prioridade: chamado.prioridade,
      status: chamado.status,
      responsavel: chamado.responsavel?.nome || null,
      dataAbertura: chamado.abertoEm,
      ultimaAtualizacao: chamado.atualizadoEm,
      encerradoEm: chamado.encerradoEm,
      motivoConclusao: chamado.motivoConclusao,
      solucaoAplicada: chamado.solucaoAplicada,
      observacoesFinais: chamado.observacoesFinais,
      historico: chamado.historicos.map((item) => ({
        id: item.id,
        dataHora: item.criadoEm,
        usuario: item.usuario.nome,
        descricao: item.descricao
      })),
      anexos: chamado.anexos.map(toAttachmentPayload)
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar chamado.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
