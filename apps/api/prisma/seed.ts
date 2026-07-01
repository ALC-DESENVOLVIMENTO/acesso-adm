import bcrypt from "bcryptjs";
import {
  PrismaClient,
  AccessLevelCode,
  PermissionOverrideType,
  PaymentFrequencyCode,
  UploadStatus
} from "@prisma/client";

const prisma = new PrismaClient();

const levels = [
  { codigo: AccessLevelCode.N1, nome: "Usuario comum", descricao: "Permissoes basicas" },
  { codigo: AccessLevelCode.N2, nome: "Financeiro ampliado", descricao: "Acesso a bases financeiras" },
  { codigo: AccessLevelCode.N3, nome: "Administrador", descricao: "Gerencia usuarios e modulos" },
  { codigo: AccessLevelCode.N4, nome: "Administrador Master", descricao: "Controle total do sistema" }
];

const modules = [
  { codigo: "dashboard", nome: "Dashboard", descricao: "Visao geral do sistema" },
  { codigo: "pdfs", nome: "Envio de PDFs", descricao: "Operacao de upload e versionamento de PDFs" },
  { codigo: "users", nome: "Usuarios", descricao: "Gestao de usuarios e niveis de acesso" },
  { codigo: "financeiro", nome: "Financeiro", descricao: "Bases e visoes financeiras" }
];

const permissions = [
  { codigo: "dashboard.view", nome: "Visualizar dashboard", moduloCodigo: "dashboard" },
  { codigo: "pdfs.view", nome: "Visualizar PDFs", moduloCodigo: "pdfs" },
  { codigo: "pdfs.upload", nome: "Enviar PDFs", moduloCodigo: "pdfs" },
  { codigo: "pdfs.replace", nome: "Substituir PDFs", moduloCodigo: "pdfs" },
  { codigo: "users.view", nome: "Visualizar usuarios", moduloCodigo: "users" },
  { codigo: "users.manage", nome: "Gerenciar usuarios", moduloCodigo: "users" },
  { codigo: "financeiro.view", nome: "Visualizar financeiro", moduloCodigo: "financeiro" }
];

const paymentBases = [
  { nome: "ARAÇATUBA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "ARAPUTANGA", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "ARAXÁ", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "BARRETOS", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "BARUERI", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "BAURU", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "CÁCERES", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "CAMPO GRANDE", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "CAMPOS DOS GOYTACAZES", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "CHAPADÃO DO SUL", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "CONCEIÇÃO DO MATO DENTRO", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "CONTAGEM", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "CORDOVIL", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "CUIABÁ", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "GOIANIA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "GUANHAES", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "GUAXUPE", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "IPATINGA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "ITABORAI", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "JALES", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "MARILIA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "MINAÇU", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "MOZARLANDIA", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "NOVA LIMA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "PATOS DE MINAS", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "POÇOS DE CALDAS", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "PONTES E LACERDA", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "POUSO ALEGRE", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "PRESIDENTE PRUDENTE", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "QUEIMADOS", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "RIBEIRAO PRETO", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "RIO VERDE", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "SÃO CARLOS", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "SÃO JOAO DE MERITI", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "SÃO JOSE DO RIO PRETO", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "SINOP", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "TEÓFILO OTONI", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "UBERABA", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "UBERLANDIA", tipoPadrao: PaymentFrequencyCode.quinzenal },
  { nome: "VESPASIANO", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "HIDROLANDIA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "VOLTA REDONDA", tipoPadrao: PaymentFrequencyCode.semanal },
  { nome: "SANTO ANTONIO DA PLATINA", tipoPadrao: PaymentFrequencyCode.quinzenal }
];

const users = [
  { nome: "Dev. Adrian", email: "adrian.ribeiro@alcepereirafilho.com.br", nivel: AccessLevelCode.N4 },
  { nome: "Dev. Wesley", email: "wesleyalc.oliveira@gmail.com", nivel: AccessLevelCode.N4 },
  { nome: "Bruno Andre", email: "bruno.andre@alcepereirafilho.com.br", nivel: AccessLevelCode.N3 },
  { nome: "Vinicius Paes", email: "vinicius.paes@alcepereirafilho.com.br", nivel: AccessLevelCode.N3 },
  { nome: "Amanda Francisco", email: "amanda.francisco@alcepereirafilho.com.br", nivel: AccessLevelCode.N2 },
  { nome: "Eder Nogueira", email: "edernogueira.1987@gmail.com", nivel: AccessLevelCode.N1 },
  { nome: "Luka Moreno", email: "lukaalcpereira@gmail.com", nivel: AccessLevelCode.N1 },
  { nome: "Isabela Alvarenga", email: "isabelarp10@gmail.com", nivel: AccessLevelCode.N1 },
  { nome: "Larissa Sabrina", email: "larissaalc7@gmail.com", nivel: AccessLevelCode.N1 },
  { nome: "Marcos Bueno", email: "marcosbueno07@outlook.com", nivel: AccessLevelCode.N1 },
  { nome: "Joao Marcelo", email: "jmsc14x14@gmail.com", nivel: AccessLevelCode.N1 }
];

async function main() {
  const hashedPassword = await bcrypt.hash("0000", 10);

  for (const level of levels) {
    await prisma.nivel.upsert({
      where: { codigo: level.codigo },
      update: {
        nome: level.nome,
        descricao: level.descricao
      },
      create: level
    });
  }

  for (const moduleItem of modules) {
    await prisma.modulo.upsert({
      where: { codigo: moduleItem.codigo },
      update: {
        nome: moduleItem.nome,
        descricao: moduleItem.descricao,
        ativo: true
      },
      create: moduleItem
    });
  }

  const modulesMap = Object.fromEntries(
    (await prisma.modulo.findMany()).map((moduleItem) => [moduleItem.codigo, moduleItem.id])
  );

  for (const permission of permissions) {
    await prisma.permissao.upsert({
      where: { codigo: permission.codigo },
      update: {
        nome: permission.nome,
        moduloId: modulesMap[permission.moduloCodigo]
      },
      create: {
        codigo: permission.codigo,
        nome: permission.nome,
        moduloId: modulesMap[permission.moduloCodigo]
      }
    });
  }

  for (const base of paymentBases) {
    await prisma.basePagamento.upsert({
      where: { nome: base.nome },
      update: {
        tipoPadrao: base.tipoPadrao,
        ativo: true
      },
      create: base
    });
  }

  const levelMap = Object.fromEntries(
    (await prisma.nivel.findMany()).map((level) => [level.codigo, level.id])
  );
  const permissionMap = Object.fromEntries(
    (await prisma.permissao.findMany()).map((permission) => [permission.codigo, permission.id])
  );

  const levelPermissions: Record<AccessLevelCode, string[]> = {
    N1: ["dashboard.view", "pdfs.view", "pdfs.upload"],
    N2: ["dashboard.view", "pdfs.view", "pdfs.upload", "financeiro.view"],
    N3: ["dashboard.view", "pdfs.view", "pdfs.upload", "pdfs.replace", "users.view", "users.manage", "financeiro.view"],
    N4: ["dashboard.view", "pdfs.view", "pdfs.upload", "pdfs.replace", "users.view", "users.manage", "financeiro.view"]
  };

  for (const [levelCode, permissionCodes] of Object.entries(levelPermissions) as Array<[AccessLevelCode, string[]]>) {
    for (const permissionCode of permissionCodes) {
      await prisma.permissaoPorNivel.upsert({
        where: {
          nivelId_permissaoId: {
            nivelId: levelMap[levelCode],
            permissaoId: permissionMap[permissionCode]
          }
        },
        update: {},
        create: {
          nivelId: levelMap[levelCode],
          permissaoId: permissionMap[permissionCode]
        }
      });
    }
  }

  for (const user of users) {
    await prisma.usuario.upsert({
      where: { email: user.email },
      update: {
        nome: user.nome,
        nivelId: levelMap[user.nivel],
        ativo: true,
        bloqueado: false,
        primeiroAcesso: true
      },
      create: {
        nome: user.nome,
        email: user.email,
        senhaHash: hashedPassword,
        nivelId: levelMap[user.nivel],
        ativo: true,
        bloqueado: false,
        primeiroAcesso: true
      }
    });
  }

  const [adminUser, amandaUser, lukaUser] = await Promise.all([
    prisma.usuario.findUniqueOrThrow({ where: { email: "adrian.ribeiro@alcepereirafilho.com.br" } }),
    prisma.usuario.findUniqueOrThrow({ where: { email: "amanda.francisco@alcepereirafilho.com.br" } }),
    prisma.usuario.findUniqueOrThrow({ where: { email: "lukaalcpereira@gmail.com" } })
  ]);

  await prisma.permissaoPorUsuario.upsert({
    where: {
      usuarioId_permissaoId: {
        usuarioId: lukaUser.id,
        permissaoId: permissionMap["financeiro.view"]
      }
    },
    update: {
      tipo: PermissionOverrideType.grant,
      concedidoPor: adminUser.id
    },
    create: {
      usuarioId: lukaUser.id,
      permissaoId: permissionMap["financeiro.view"],
      tipo: PermissionOverrideType.grant,
      concedidoPor: adminUser.id
    }
  });

  const uploadSeeds = [
    {
      nomeArquivo: "conhecimento_12345_v1.pdf",
      nomeOriginal: "Conhecimento_12345.pdf",
      caminhoArquivo: "/uploads/conhecimento_12345_v1.pdf",
      versao: 1,
      status: UploadStatus.processado,
      usuarioId: amandaUser.id
    },
    {
      nomeArquivo: "romaneio_99987_v1.pdf",
      nomeOriginal: "Romaneio_99987.pdf",
      caminhoArquivo: "/uploads/romaneio_99987_v1.pdf",
      versao: 1,
      status: UploadStatus.pendente,
      usuarioId: lukaUser.id
    }
  ];

  for (const upload of uploadSeeds) {
    const exists = await prisma.uploadPdf.findFirst({
      where: {
        nomeArquivo: upload.nomeArquivo
      }
    });

    if (!exists) {
      await prisma.uploadPdf.create({
        data: upload
      });
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
