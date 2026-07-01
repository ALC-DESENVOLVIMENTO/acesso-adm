import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.get("/", (_req, res) => {
  void (async () => {
    const users = await prisma.usuario.findMany({
      include: {
        nivel: {
          include: {
            permissoesPorNivel: {
              include: {
                permissao: {
                  include: {
                    modulo: true
                  }
                }
              }
            }
          }
        },
        permissoesPorUsuario: {
          include: {
            permissao: {
              include: {
                modulo: true
              }
            }
          }
        }
      },
      orderBy: {
        nome: "asc"
      }
    });

    res.json(
      users.map((user) => ({
        id: user.id,
        name: user.nome,
        email: user.email,
        level: user.nivel.codigo,
        active: user.ativo,
        blocked: user.bloqueado,
        firstAccess: user.primeiroAcesso,
        lastLoginAt: user.ultimoLoginEm,
        modules: Array.from(
          new Set([
            ...user.nivel.permissoesPorNivel.map((item) => item.permissao.modulo.codigo),
            ...user.permissoesPorUsuario
              .filter((item) => item.tipo === "grant")
              .map((item) => item.permissao.modulo.codigo)
          ])
        ).filter(
          (moduleCode) =>
            !user.permissoesPorUsuario.some(
              (item) => item.tipo === "deny" && item.permissao.modulo.codigo === moduleCode
            )
        )
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar usuarios.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
