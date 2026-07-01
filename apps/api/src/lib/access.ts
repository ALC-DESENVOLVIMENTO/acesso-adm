import { Prisma, PermissionOverrideType } from "@prisma/client";
import { prisma } from "./prisma.js";

const userAccessInclude = {
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
} satisfies Prisma.UsuarioInclude;

type UserAccessPayload = Prisma.UsuarioGetPayload<{
  include: typeof userAccessInclude;
}>;

export function getUserAccessInclude() {
  return userAccessInclude;
}

export function resolveEffectiveModules(user: UserAccessPayload) {
  const modules = new Set(
    user.nivel.permissoesPorNivel.map((item) => item.permissao.modulo.codigo)
  );

  for (const override of user.permissoesPorUsuario) {
    const moduleCode = override.permissao.modulo.codigo;

    if (override.tipo === PermissionOverrideType.grant) {
      modules.add(moduleCode);
    }

    if (override.tipo === PermissionOverrideType.deny) {
      modules.delete(moduleCode);
    }
  }

  return Array.from(modules).sort();
}

export async function syncUserModuleOverrides(params: {
  userId: string;
  levelId: string;
  desiredModules: string[];
  grantedByUserId: string;
}) {
  const [allPermissions, levelPermissions] = await Promise.all([
    prisma.permissao.findMany({
      include: {
        modulo: true
      }
    }),
    prisma.permissaoPorNivel.findMany({
      where: {
        nivelId: params.levelId
      },
      include: {
        permissao: {
          include: {
            modulo: true
          }
        }
      }
    })
  ]);

  const desiredModuleSet = new Set(params.desiredModules);
  const defaultModuleSet = new Set(levelPermissions.map((item) => item.permissao.modulo.codigo));
  const permissionsByModule = new Map<string, string[]>();

  for (const permission of allPermissions) {
    const current = permissionsByModule.get(permission.modulo.codigo) || [];
    current.push(permission.id);
    permissionsByModule.set(permission.modulo.codigo, current);
  }

  await prisma.permissaoPorUsuario.deleteMany({
    where: {
      usuarioId: params.userId
    }
  });

  const overrideRows = Array.from(permissionsByModule.entries()).flatMap(([moduleCode, permissionIds]) => {
    const shouldHaveModule = desiredModuleSet.has(moduleCode);
    const hasByDefault = defaultModuleSet.has(moduleCode);

    if (shouldHaveModule === hasByDefault) {
      return [];
    }

    const tipo = shouldHaveModule ? PermissionOverrideType.grant : PermissionOverrideType.deny;

    return permissionIds.map((permissionId) => ({
      usuarioId: params.userId,
      permissaoId: permissionId,
      tipo,
      concedidoPor: params.grantedByUserId
    }));
  });

  if (overrideRows.length > 0) {
    await prisma.permissaoPorUsuario.createMany({
      data: overrideRows
    });
  }
}
