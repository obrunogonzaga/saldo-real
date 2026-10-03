import { isIP } from "node:net";
import nodemailer, { type Transporter } from "nodemailer";
import { siteName } from "@/lib/site";
import { recordOperationalFailure } from "./operational-failures";

interface SmtpConfiguration {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
}

let transporter: Transporter | undefined;

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

function isLoopbackAuthUrl(): boolean {
  const authUrl = process.env.BETTER_AUTH_URL ?? process.env.AUTH_BASE_URL;

  if (!authUrl) {
    return false;
  }

  try {
    return isLoopbackHost(new URL(authUrl).hostname);
  } catch {
    return false;
  }
}

function parseSmtpPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const port = Number(value);

  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function parseSmtpSecure(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function getSmtpConfiguration(): SmtpConfiguration {
  const host = process.env.SMTP_HOST?.trim();
  const port = parseSmtpPort(process.env.SMTP_PORT);
  const secure = parseSmtpSecure(process.env.SMTP_SECURE);
  const from = process.env.SMTP_FROM?.trim();

  if (!host || !port || secure === undefined || !from) {
    throw new Error("O envio de e-mail não está configurado.");
  }

  const isLocal = process.env.APP_ENV === "local";
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;

  if (isLocal) {
    if (!isLoopbackHost(host) || !isLoopbackAuthUrl()) {
      throw new Error(
        "O SMTP local precisa usar somente endereços de loopback.",
      );
    }
  } else if (!secure || !user || !password) {
    throw new Error("O SMTP de produção exige TLS e credenciais.");
  }

  return {
    host,
    port,
    secure,
    from,
    user,
    password,
  };
}

function getTransporter(): Transporter {
  if (transporter) {
    return transporter;
  }

  const config = getSmtpConfiguration();
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
  });

  return transporter;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };

    return entities[character] ?? character;
  });
}

async function sendAuthEmail(
  subject: string,
  text: string,
  html: string,
  recipient: string,
): Promise<void> {
  try {
    const config = getSmtpConfiguration();
    await getTransporter().sendMail({
      from: config.from,
      to: recipient,
      subject,
      text,
      html,
    });
  } catch {
    await recordOperationalFailure("email");
    throw new Error("Não foi possível enviar o e-mail. Tente novamente.");
  }
}

export async function sendVerificationEmail(
  recipient: string,
  verificationUrl: string,
): Promise<void> {
  const safeUrl = escapeHtml(verificationUrl);

  await sendAuthEmail(
    `Confirme seu e-mail no ${siteName}`,
    `Confirme seu e-mail para entrar no ${siteName}: ${verificationUrl}`,
    `<p>Confirme seu e-mail para entrar no ${siteName}.</p><p><a href="${safeUrl}">Confirmar e-mail</a></p>`,
    recipient,
  );
}

export async function sendPasswordResetEmail(
  recipient: string,
  resetUrl: string,
): Promise<void> {
  const safeUrl = escapeHtml(resetUrl);

  await sendAuthEmail(
    `Redefina sua senha do ${siteName}`,
    `Redefina sua senha do ${siteName}: ${resetUrl}`,
    `<p>Use o link para redefinir sua senha do ${siteName}.</p><p><a href="${safeUrl}">Redefinir senha</a></p>`,
    recipient,
  );
}

export async function sendSubscriptionCancellationEmail(
  recipient: string,
  paidUntil: Date,
): Promise<void> {
  const date = paidUntil.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
  await sendAuthEmail(
    `Assinatura PRO cancelada no ${siteName}`,
    `Sua assinatura PRO foi cancelada. Não haverá novas renovações. O acesso já pago permanece até ${date}. Seus produtos continuam salvos.`,
    `<p>Sua assinatura PRO foi cancelada. Não haverá novas renovações.</p><p>O acesso já pago permanece até ${date}. Seus produtos continuam salvos.</p>`,
    recipient,
  );
}

export async function sendSupportRequestEmail(input: {
  protocol: string;
  fromEmail: string;
  category: string;
  message: string;
}): Promise<void> {
  const destination = process.env.SUPPORT_EMAIL?.trim() || "bruno@aifbr.com.br";
  await sendAuthEmail(
    `Suporte Líquido ${input.protocol}`,
    `Protocolo: ${input.protocol}\nConta: ${input.fromEmail}\nAssunto: ${input.category}\n\n${input.message}`,
    `<p>Protocolo: ${escapeHtml(input.protocol)}</p><p>Conta: ${escapeHtml(input.fromEmail)}</p><p>Assunto: ${escapeHtml(input.category)}</p><p>${escapeHtml(input.message).replace(/\n/g, "<br>")}</p>`,
    destination,
  );
}

export function resetMailerForTests(): void {
  transporter = undefined;
}
